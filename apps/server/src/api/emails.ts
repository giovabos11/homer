// Emails + outbox routes (contract §Emails & outbox — FR-2, FR-11, FR-20).
import { Router } from 'express';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { emails } from '../db/schema';
import { toEmail } from '../db/serialize';
import type { AppContext } from '../context';
import { ApiError, idParam, parseBody, parseQuery } from './util';

export function emailRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/emails', (req, res) => {
    const q = parseQuery(
      z.object({
        direction: z.enum(['inbound', 'outbound']).optional(),
        classification: z
          .enum(['reply_accepted', 'reply_rejected', 'interview_invite', 'opportunity', 'followup', 'other'])
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req,
    );
    const filters: SQL[] = [];
    if (q.direction) filters.push(eq(emails.direction, q.direction));
    if (q.classification) filters.push(eq(emails.classification, q.classification));
    const where = filters.length > 0 ? and(...filters) : undefined;
    const total = ctx.db.select({ n: sql<number>`count(*)` }).from(emails).where(where).get()?.n ?? 0;
    const rows = ctx.db
      .select()
      .from(emails)
      .where(where)
      .orderBy(desc(emails.id))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    res.json({ total, emails: rows.map(toEmail) });
  });

  // Outbox = outbound drafts awaiting approval (FR-11: nothing sends without one).
  router.get('/outbox', (_req, res) => {
    const rows = ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.direction, 'outbound'), eq(emails.needsApproval, 1)))
      .orderBy(desc(emails.id))
      .all();
    res.json(rows.map(toEmail));
  });

  router.post('/outbox/:id/approve', (req, res) => {
    const id = idParam(req);
    const existing = ctx.db.select().from(emails).where(eq(emails.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No email ${id}`);
    if (existing.direction !== 'outbound' || existing.needsApproval !== 1) {
      throw new ApiError(409, 'invalid_state', `Email ${id} is not an outbox draft awaiting approval`);
    }
    const row = ctx.db
      .update(emails)
      .set({ approvedAt: new Date().toISOString() })
      .where(eq(emails.id, id))
      .returning()
      .get();
    ctx.queue.enqueue('email_send', { payload: { emailId: id } });
    const dto = toEmail(row);
    ctx.bus.emit({ type: 'outbox.updated', email: dto });
    res.json(dto);
  });

  router.post('/outbox/:id/reject', (req, res) => {
    const id = idParam(req);
    const body = parseBody(z.object({ reason: z.string().optional() }), req);
    const existing = ctx.db.select().from(emails).where(eq(emails.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No email ${id}`);
    const row = ctx.db
      .update(emails)
      .set({
        needsApproval: 0,
        approvedAt: null,
        summary: body.reason ? `${existing.summary} [rejected: ${body.reason}]` : `${existing.summary} [rejected]`,
      })
      .where(eq(emails.id, id))
      .returning()
      .get();
    const dto = toEmail(row);
    ctx.bus.emit({ type: 'outbox.updated', email: dto });
    res.json(dto);
  });

  // Manual trigger of the periodic scan (FR-2).
  router.post('/emails/scan', (_req, res) => {
    const task = ctx.queue.enqueue('email_scan', { dedupe: true, payload: { trigger: 'manual' } });
    res.json({ taskId: task.id });
  });

  return router;
}
