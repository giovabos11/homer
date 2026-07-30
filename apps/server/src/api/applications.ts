// Applications routes (contract §Applications — FR-9, FR-16, FR-19, FR-25).
import path from 'node:path';
import { Router } from 'express';
import { and, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { applications, jobs } from '../db/schema';
import { toApplication } from '../db/serialize';
import { addAudit, updateApplication, updateJob } from '../workers/helpers';
import type { AppContext } from '../context';
import { ApiError, idParam, parseBody, parseQuery } from './util';

const STATUS_VALUES = [
  'discovered', 'screened', 'tailoring', 'ready_for_review', 'applied', 'interview',
  'offer', 'hired', 'rejected', 'no_response', 'withdrawn', 'quarantined', 'skipped',
] as const;

export function applicationRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/applications', (req, res) => {
    const q = parseQuery(
      z.object({
        status: z.string().optional(),
        q: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req,
    );
    const filters: SQL[] = [];
    if (q.status) filters.push(eq(applications.status, q.status));
    if (q.q) {
      const term = `%${q.q}%`;
      filters.push(or(like(jobs.company, term), like(jobs.title, term))!);
    }
    const where = filters.length > 0 ? and(...filters) : undefined;
    const total =
      ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(applications)
        .innerJoin(jobs, eq(jobs.id, applications.jobId))
        .where(where)
        .get()?.n ?? 0;
    const rows = ctx.db
      .select({ app: applications, job: jobs })
      .from(applications)
      .innerJoin(jobs, eq(jobs.id, applications.jobId))
      .where(where)
      .orderBy(desc(applications.updatedAt))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    res.json({ total, applications: rows.map(({ app, job }) => toApplication(app, job)) });
  });

  // Kanban drag = status change; notes are append-only.
  router.patch('/applications/:id', (req, res) => {
    const id = idParam(req);
    const body = parseBody(
      z.object({ status: z.enum(STATUS_VALUES).optional(), notes: z.string().optional() }),
      req,
    );
    const existing = ctx.db.select().from(applications).where(eq(applications.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No application ${id}`);

    const patch: Partial<typeof existing> = {};
    if (body.status) patch.status = body.status;
    if (body.notes) {
      const notes = JSON.parse(existing.notesJson) as { date: string; text: string }[];
      notes.push({ date: new Date().toISOString(), text: body.notes });
      patch.notesJson = JSON.stringify(notes);
    }
    // Job first: updateApplication emits application.updated with the job
    // fetched at emit time, so the job row must already carry the new status.
    if (body.status) updateJob(ctx, existing.jobId, { status: body.status });
    const row = updateApplication(ctx, id, patch);
    const job = ctx.db.select().from(jobs).where(eq(jobs.id, existing.jobId)).get();
    res.json(toApplication(row, job));
  });

  // FR-9/D1: the user approval click at the submit gate.
  router.post('/applications/:id/approve', (req, res) => {
    const id = idParam(req);
    const existing = ctx.db.select().from(applications).where(eq(applications.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No application ${id}`);
    if (existing.status !== 'ready_for_review') {
      throw new ApiError(409, 'invalid_state', `Application ${id} is ${existing.status}, not ready_for_review`);
    }
    updateApplication(ctx, id, { approvedAt: new Date().toISOString() });
    addAudit(ctx, id, 'gate.user_approved', {});
    const task = ctx.queue.enqueue('apply', { payload: { applicationId: id } });
    res.json({ taskId: task.id });
  });

  // Reject at the gate: back to tailoring (retailor: true) or skipped (default).
  router.post('/applications/:id/reject', (req, res) => {
    const id = idParam(req);
    const body = parseBody(z.object({ reason: z.string().min(1), retailor: z.boolean().optional() }), req);
    const existing = ctx.db.select().from(applications).where(eq(applications.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No application ${id}`);

    const notes = JSON.parse(existing.notesJson) as { date: string; text: string }[];
    notes.push({ date: new Date().toISOString(), text: `Rejected at review gate: ${body.reason}` });
    const nextStatus = body.retailor ? 'tailoring' : 'skipped';
    updateJob(ctx, existing.jobId, { status: nextStatus }); // before the emitting updateApplication
    const row = updateApplication(ctx, id, {
      status: nextStatus,
      approvedAt: null,
      notesJson: JSON.stringify(notes),
    });
    addAudit(ctx, id, 'gate.user_rejected', { reason: body.reason, retailor: body.retailor === true });
    if (body.retailor) ctx.queue.enqueue('tailor', { payload: { jobId: existing.jobId } });
    const job = ctx.db.select().from(jobs).where(eq(jobs.id, existing.jobId)).get();
    res.json(toApplication(row, job));
  });

  router.get('/applications/:id/artifacts', (req, res) => {
    const id = idParam(req);
    const existing = ctx.db.select().from(applications).where(eq(applications.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No application ${id}`);
    const asUrl = (p: string | null): string | null => {
      if (!p) return null;
      const rel = path.isAbsolute(p) ? path.relative(ctx.artifactsDir, p) : p;
      if (rel.startsWith('..')) return null; // outside the served artifacts dir
      return `/files/${rel.split(path.sep).join('/')}`;
    };
    const audit = JSON.parse(existing.auditJson) as { screenshot?: string | null }[];
    res.json({
      resumeUrl: asUrl(existing.resumePath),
      coverLetterUrl: asUrl(existing.coverLetterPath),
      screenshots: audit.map((a) => a.screenshot).filter((s): s is string => typeof s === 'string'),
      answers: existing.answersJson ? JSON.parse(existing.answersJson) : null,
    });
  });

  return router;
}
