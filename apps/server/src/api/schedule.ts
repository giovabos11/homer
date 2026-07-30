// Schedule, prep tasks & skills progress (contract §Schedule, interviews & skills — FR-12, FR-13, FR-21, FR-23).
import { Router } from 'express';
import { and, asc, eq, gte, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SkillProgress } from '@shared/types';
import { prepTasks, scheduleEvents, skillsProgress } from '../db/schema';
import { toPrepTask, toScheduleEvent } from '../db/serialize';
import { recomputeSkillsProgress } from '../workers/prep-guide';
import type { AppContext } from '../context';
import { ApiError, idParam, parseBody, parseQuery } from './util';

export function scheduleRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/schedule', (req, res) => {
    const q = parseQuery(z.object({ from: z.string().optional(), to: z.string().optional() }), req);
    const filters: SQL[] = [];
    if (q.from) filters.push(gte(scheduleEvents.startsAt, q.from));
    if (q.to) filters.push(lte(scheduleEvents.startsAt, q.to));
    const rows = ctx.db
      .select()
      .from(scheduleEvents)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(scheduleEvents.startsAt))
      .all();
    res.json(rows.map(toScheduleEvent));
  });

  router.post('/schedule', (req, res) => {
    const body = parseBody(
      z.object({
        type: z.enum(['interview', 'deadline', 'followup_due', 'prep', 'other']).default('other'),
        applicationId: z.number().int().nullish(),
        title: z.string().min(1),
        startsAt: z.string().min(1),
        endsAt: z.string().nullish(),
        company: z.string().nullish(),
      }),
      req,
    );
    const row = ctx.db
      .insert(scheduleEvents)
      .values({
        type: body.type,
        applicationId: body.applicationId ?? null,
        title: body.title,
        startsAt: body.startsAt,
        endsAt: body.endsAt ?? null,
        company: body.company ?? null,
      })
      .returning()
      .get();
    const dto = toScheduleEvent(row);
    ctx.bus.emit({ type: 'schedule.updated', event: dto });
    // Interviews get a study guide automatically (FR-13).
    if (body.type === 'interview') ctx.queue.enqueue('prep_guide', { payload: { eventId: row.id } });
    res.status(201).json(dto);
  });

  router.post('/schedule/:id/prep', (req, res) => {
    const id = idParam(req);
    const row = ctx.db.select().from(scheduleEvents).where(eq(scheduleEvents.id, id)).get();
    if (!row) throw new ApiError(404, 'not_found', `No schedule event ${id}`);
    const task = ctx.queue.enqueue('prep_guide', { payload: { eventId: id } });
    res.json({ taskId: task.id });
  });

  router.get('/prep-tasks', (req, res) => {
    const q = parseQuery(z.object({ eventId: z.coerce.number().int().optional() }), req);
    const rows = ctx.db
      .select()
      .from(prepTasks)
      .where(q.eventId != null ? eq(prepTasks.eventId, q.eventId) : undefined)
      .orderBy(asc(prepTasks.id))
      .all();
    res.json(rows.map(toPrepTask));
  });

  router.patch('/prep-tasks/:id', (req, res) => {
    const id = idParam(req);
    const body = parseBody(z.object({ done: z.boolean() }), req);
    const row = ctx.db
      .update(prepTasks)
      .set({ doneAt: body.done ? new Date().toISOString() : null })
      .where(eq(prepTasks.id, id))
      .returning()
      .get();
    if (!row) throw new ApiError(404, 'not_found', `No prep task ${id}`);
    recomputeSkillsProgress(ctx); // keep the FR-23 skill meters current
    res.json(toPrepTask(row));
  });

  // FR-23: skill meters computed from prep tasks (+ any seeded skills_progress evidence).
  router.get('/skills-progress', (_req, res) => {
    const byTag = ctx.db
      .select({
        skill: prepTasks.skillTag,
        total: sql<number>`count(*)`,
        done: sql<number>`sum(CASE WHEN ${prepTasks.doneAt} IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(prepTasks)
      .where(isNotNull(prepTasks.skillTag))
      .groupBy(prepTasks.skillTag)
      .all();
    const seeded = ctx.db.select().from(skillsProgress).all();
    const evidenceBySkill = new Map(seeded.map((s) => [s.skill, JSON.parse(s.evidenceJson) as string[]]));
    const out: SkillProgress[] = byTag.map((row) => ({
      skill: row.skill ?? 'general',
      totalTasks: row.total,
      doneTasks: row.done ?? 0,
      evidence: evidenceBySkill.get(row.skill ?? '') ?? [],
    }));
    // Skills tracked only via upskill evidence (no prep tasks yet).
    for (const s of seeded) {
      if (!out.some((o) => o.skill === s.skill)) {
        out.push({ skill: s.skill, totalTasks: 0, doneTasks: 0, evidence: evidenceBySkill.get(s.skill) ?? [] });
      }
    }
    res.json(out);
  });

  return router;
}
