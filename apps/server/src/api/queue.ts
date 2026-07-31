// Search + queue routes (contract §Search & queue — FR-1, FR-3, FR-18, FR-25).
import crypto from 'node:crypto';
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { QueueTask, ScheduleNextRuns, SourceBudget, TaskState, TaskType } from '@shared/types';
import { applications } from '../db/schema';
import { toQueueTask } from '../db/serialize';
import { listSources } from './sources';
import { normalizeAnswers } from '../docs/screening';
import { addAudit, updateApplication } from '../workers/helpers';
import { PRIORITY } from '../queue/queue';
import type { AppContext } from '../context';
import { ApiError, idParam, parseBody } from './util';

export function queueSnapshot(ctx: AppContext): {
  tasks: QueueTask[];
  budgets: SourceBudget[];
  paused: boolean;
  nextRuns: ScheduleNextRuns;
} {
  return {
    tasks: ctx.queue.list().map(toQueueTask),
    budgets: listSources(ctx), // enriched: keyGated / blockedReason
    paused: ctx.queue.isPaused(),
    nextRuns: ctx.scheduler.nextRuns(),
  };
}

const TASK_TYPES = [
  'discover', 'score', 'tailor', 'apply', 'email_scan', 'email_send', 'followup',
  'prep_guide', 'profile_sync', 'ask', 'feedback', 'setup', 'regen_queries',
] as const satisfies readonly TaskType[];

export function queueRoutes(ctx: AppContext): Router {
  const router = Router();

  // FR-3: manual search fans out to portal CLIs; results stream via job.discovered SSE.
  router.post('/search', (req, res) => {
    const body = parseBody(
      z.object({
        keywords: z.string().min(1),
        experience: z.string().optional(),
        remote: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
        location: z.string().optional(),
        sources: z.array(z.string()).optional(),
      }),
      req,
    );
    const searchId = crypto.randomUUID();
    ctx.queue.enqueue('discover', {
      priority: PRIORITY.user,
      payload: {
        trigger: 'manual_search',
        searchId,
        keywords: body.keywords,
        experience: body.experience,
        remote: body.remote,
        location: body.location,
        sources: body.sources,
      },
    });
    res.json({ searchId });
  });

  router.get('/queue', (_req, res) => {
    res.json(queueSnapshot(ctx));
  });

  // Run a discovery sweep right now. Deduped: if a discover task is already
  // pending/running, that task is returned instead of enqueueing another.
  // Per-source budgets are still respected inside the worker.
  router.post('/queue/run-discovery', (_req, res) => {
    const row = ctx.queue.enqueue('discover', { dedupe: true, priority: PRIORITY.user, payload: { trigger: 'manual_run' } });
    const dto = toQueueTask(row);
    ctx.bus.emit({ type: 'queue.updated', task: dto });
    res.json({ taskId: row.id });
  });

  router.post('/queue/pause', (_req, res) => {
    ctx.queue.setPaused(true);
    const snapshot = queueSnapshot(ctx);
    ctx.bus.emit({ type: 'queue.snapshot', ...snapshot });
    res.json(snapshot);
  });

  router.post('/queue/resume', (_req, res) => {
    ctx.queue.setPaused(false);
    const snapshot = queueSnapshot(ctx);
    ctx.bus.emit({ type: 'queue.snapshot', ...snapshot });
    res.json(snapshot);
  });

  router.post('/queue/rate', (req, res) => {
    const body = parseBody(z.object({ discoveryIntervalMinutes: z.number().int().min(15).max(1440) }), req);
    const settings = ctx.settings.patch({ discoveryIntervalMinutes: body.discoveryIntervalMinutes });
    ctx.scheduler.reschedule();
    res.json(settings);
  });

  // Bulk retry: every failed task (optionally one type) back to pending with
  // attempts reset. Explicit user cancellations stay cancelled.
  router.post('/queue/retry-failed', (req, res) => {
    const body = parseBody(z.object({ type: z.enum(TASK_TYPES).optional() }), req);
    const rows = ctx.queue.retryAllFailed(body.type);
    const snapshot = queueSnapshot(ctx);
    ctx.bus.emit({ type: 'queue.snapshot', ...snapshot });
    res.json({ requeued: rows.length });
  });

  /**
   * The user finished the manual step. `answers` carries the choices they made
   * on the option buttons the driver attached to the task payload — they are
   * written back onto the application so the next run does not ask again.
   */
  router.post('/queue/tasks/:id/resolve-human', (req, res) => {
    const id = idParam(req);
    const body = parseBody(z.object({ answers: z.record(z.string(), z.string()).optional() }), req);
    const task = ctx.queue.get(id);
    if (!task) throw new ApiError(404, 'not_found', `No task ${id}`);
    if (task.state !== 'needs_human') {
      throw new ApiError(409, 'invalid_state', `Task ${id} is ${task.state}, not needs_human`);
    }
    if (body.answers && Object.keys(body.answers).length > 0) {
      const payload = JSON.parse(task.payloadJson) as { applicationId?: number };
      if (payload.applicationId != null) {
        applyAnswerChoices(ctx, payload.applicationId, body.answers);
      }
    }
    const row = ctx.queue.resolveHuman(id);
    const dto = toQueueTask(row);
    ctx.bus.emit({ type: 'queue.updated', task: dto });
    res.json(dto);
  });

  /**
   * Bulk stop. 'running' aborts in-flight tasks (killing their CLI child
   * process); 'pending' clears the backlog; 'all' does both.
   */
  router.post('/queue/cancel-all', (req, res) => {
    const body = parseBody(
      z.object({ scope: z.enum(['running', 'pending', 'all']).default('all'), type: z.enum(TASK_TYPES).optional() }),
      req,
    );
    const states: TaskState[] =
      body.scope === 'running' ? ['running'] : body.scope === 'pending' ? ['pending', 'paused', 'waiting_session'] : ['running', 'pending', 'paused', 'waiting_session'];
    const rows = ctx.queue.listByState(states, body.type);
    let cancelled = 0;
    for (const row of rows) {
      ctx.cancellations.abort(row.id);
      ctx.queue.cancel(row.id);
      cancelled += 1;
    }
    const snapshot = queueSnapshot(ctx);
    ctx.bus.emit({ type: 'queue.snapshot', ...snapshot });
    res.json({ cancelled });
  });

  router.post('/queue/tasks/:id/retry', (req, res) => {
    const id = idParam(req);
    if (!ctx.queue.get(id)) throw new ApiError(404, 'not_found', `No task ${id}`);
    const row = ctx.queue.retry(id);
    const dto = toQueueTask(row);
    ctx.bus.emit({ type: 'queue.updated', task: dto });
    res.json(dto);
  });

  // Cancels pending AND running tasks: aborting the in-flight controller kills
  // the spawned CLI process tree, so the slot frees immediately (PRD §11).
  router.post('/queue/tasks/:id/cancel', (req, res) => {
    const id = idParam(req);
    if (!ctx.queue.get(id)) throw new ApiError(404, 'not_found', `No task ${id}`);
    const aborted = ctx.cancellations.abort(id);
    const row = ctx.queue.cancel(id);
    const dto = toQueueTask(row);
    ctx.bus.emit({ type: 'queue.updated', task: dto });
    const snapshot = queueSnapshot(ctx);
    ctx.bus.emit({ type: 'queue.snapshot', ...snapshot });
    res.json({ ...dto, aborted });
  });

  return router;
}

/**
 * Write the user's option-button picks back onto the application's screening
 * answers, so the retried apply run fills them instead of parking again.
 */
function applyAnswerChoices(ctx: AppContext, applicationId: number, answers: Record<string, string>): void {
  const row = ctx.db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!row) return;
  const current = normalizeAnswers(row.answersJson ? (JSON.parse(row.answersJson) as Record<string, unknown>) : {});
  for (const [question, value] of Object.entries(answers)) {
    if (value.trim()) current[question] = value.trim();
  }
  updateApplication(ctx, applicationId, { answersJson: JSON.stringify(current) });
  addAudit(ctx, applicationId, 'answers.resolved_by_user', { questions: Object.keys(answers) });
}
