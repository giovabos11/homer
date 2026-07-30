// Internal localhost-only routes for the interactive /email-bridge command
// (PRD D4). A claude.ai session with the Gmail connector runs the scan/send
// that headless workers cannot, then POSTs results here; this resolves the
// parked waiting_session email tasks. The server binds 127.0.0.1 (PRD §8) and
// these routes additionally verify the peer address is loopback.
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { emails } from '../db/schema';
import { toQueueTask } from '../db/serialize';
import { processScanItems, scanItemSchema } from '../workers/email-intake';
import { markEmailSent } from '../workers/email-send';
import type { AppContext } from '../context';
import { ApiError, parseBody } from './util';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function localhostOnly(req: Request, _res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? '';
  if (!LOOPBACK.has(addr)) {
    next(new ApiError(403, 'forbidden', 'Internal routes are localhost-only'));
    return;
  }
  next();
}

export function internalRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use('/internal', localhostOnly);

  /** Waiting email tasks of a type → done, with SSE updates. */
  function resolveWaiting(type: 'email_scan' | 'email_send', matches: (payload: Record<string, unknown>) => boolean): number[] {
    const resolved: number[] = [];
    for (const task of ctx.queue.list(200)) {
      if (task.type !== type || task.state !== 'waiting_session') continue;
      const payload = JSON.parse(task.payloadJson) as Record<string, unknown>;
      if (!matches(payload)) continue;
      const row = ctx.queue.complete(task.id);
      resolved.push(task.id);
      ctx.bus.emit({ type: 'queue.updated', task: toQueueTask(row) });
    }
    return resolved;
  }

  // Scan results from the bridge session → same intake path as the worker.
  router.post('/internal/email-bridge/scan-results', (req, res) => {
    const body = parseBody(z.object({ items: z.array(scanItemSchema) }), req);
    const summary = processScanItems(ctx, body.items);
    const resolvedTasks = resolveWaiting('email_scan', () => true);
    ctx.bus.emit({
      type: 'connection.updated',
      connection: {
        name: 'gmail',
        status: 'ok',
        detail: `Bridge scan: ${summary.inserted} new email(s)`,
        lastOk: new Date().toISOString(),
      },
    });
    res.json({ ...summary, resolvedTasks });
  });

  // A single approved outbox item was sent by the bridge session.
  router.post('/internal/email-bridge/sent', (req, res) => {
    const body = parseBody(z.object({ emailId: z.number().int().positive() }), req);
    const email = ctx.db.select().from(emails).where(eq(emails.id, body.emailId)).get();
    if (!email) throw new ApiError(404, 'not_found', `No email ${body.emailId}`);
    if (email.direction !== 'outbound' || !email.approvedAt) {
      throw new ApiError(409, 'invalid_state', `Email ${body.emailId} is not an approved outbound draft — only approved outbox items may be reported as sent (FR-11)`);
    }
    if (!email.sentAt) markEmailSent(ctx, email);
    const resolvedTasks = resolveWaiting('email_send', (payload) => payload.emailId === body.emailId);
    res.json({ ok: true, resolvedTasks });
  });

  return router;
}
