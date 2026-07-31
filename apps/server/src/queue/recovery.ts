// Zombie-task & stuck-job recovery.
//
// Dev-server restarts (tsx watch) kill workers mid-task: their queue claims
// stay 'running' forever and the jobs they were driving stay 'tailoring'
// with nothing behind them. Recovery runs on boot (reclaim everything — before
// the runner starts nothing can legitimately be running) and on a periodic
// sweep (10-minute staleness threshold so a live long run is never stolen).
//
// Also repairs jobs stranded as skipped-with-scam-verdict from before the
// "quarantined jobs keep status='quarantined'" rule, so they are findable
// in the dashboard's Quarantined filter and can be manually overridden.
import { and, eq, inArray } from 'drizzle-orm';
import type { TaskState } from '@shared/types';
import { applications, jobs, taskQueue } from '../db/schema';
import { toJob, toQueueTask } from '../db/serialize';
import { updateApplication, updateJob } from '../workers/helpers';
import { autoAdvanceEligible } from '../workers/score';
import { PRIORITY } from './queue';
import type { AppContext } from '../context';

/** A 'running' claim untouched for this long is considered dead. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;
/** How often the periodic sweep runs. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const ACTIVE_STATES: TaskState[] = ['pending', 'running', 'paused', 'needs_human', 'waiting_session'];

/** Requeue stale running claims; emits queue.updated per reclaimed task. */
export function reclaimStaleTasks(ctx: AppContext, olderThanMs: number): number {
  const rows = ctx.queue.reclaimStale(olderThanMs);
  for (const row of rows) ctx.bus.emit({ type: 'queue.updated', task: toQueueTask(row) });
  if (rows.length > 0) {
    console.log(`[recovery] reclaimed ${rows.length} stale running task(s) back to pending`);
  }
  return rows.length;
}

/**
 * Jobs stuck in status='tailoring' with no live tailor task behind them go
 * back to 'screened' (ready-for-manual semantics — the user decides whether
 * to re-run the apply pipeline). Runs AFTER reclaimStaleTasks so reclaimed
 * pending tailor tasks still count as live and simply resume.
 */
export function recoverStuckTailoringJobs(ctx: AppContext): number {
  const liveTailorJobIds = new Set<number>();
  const liveTailors = ctx.db
    .select()
    .from(taskQueue)
    .where(and(eq(taskQueue.type, 'tailor'), inArray(taskQueue.state, ACTIVE_STATES)))
    .all();
  for (const t of liveTailors) {
    try {
      const payload = JSON.parse(t.payloadJson) as { jobId?: number };
      if (typeof payload.jobId === 'number') liveTailorJobIds.add(payload.jobId);
    } catch {
      /* unparseable payload → cannot vouch for any job */
    }
  }

  const stuck = ctx.db
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'tailoring'))
    .all()
    .filter((j) => !liveTailorJobIds.has(j.id));

  for (const j of stuck) {
    updateJob(ctx, j.id, { status: 'screened' }, 'job.scored');
    const app = ctx.db.select().from(applications).where(eq(applications.jobId, j.id)).get();
    if (app && app.status === 'tailoring') updateApplication(ctx, app.id, { status: 'screened' });
    ctx.bus.emit({
      type: 'toast',
      level: 'warning',
      message: `${j.company} — ${j.title} was stuck in tailoring (worker died) — moved back to Screened`,
    });
  }
  if (stuck.length > 0) {
    console.log(`[recovery] recovered ${stuck.length} job(s) stuck in tailoring back to screened`);
  }
  return stuck.length;
}

/** Per-sweep cap on backfill tailor enqueues — keeps a big backlog from flooding the queue. */
export const AUTO_ADVANCE_BACKFILL_CAP = 10;

/**
 * Auto-advance backfill: screened jobs that already clear the auto-advance
 * gate (scored before auto-advance existed, or before the threshold was
 * lowered) get their tailor task retroactively. Same eligibility check as
 * at-scoring-time advance (legit, no veto, threshold, no application/active
 * tailor task), capped per sweep. Runs at boot, on the periodic sweep, and
 * whenever the autoAdvance settings change.
 */
export function backfillAutoAdvance(ctx: AppContext, cap = AUTO_ADVANCE_BACKFILL_CAP): number {
  if (ctx.settings.get().autoAdvance === 'off') return 0;
  const screened = ctx.db.select().from(jobs).where(eq(jobs.status, 'screened')).all();
  let advanced = 0;
  for (const job of screened) {
    if (advanced >= cap) break;
    if (!autoAdvanceEligible(ctx, job)) continue;
    ctx.queue.enqueue('tailor', {
      priority: PRIORITY.autoAdvance,
      payload: { jobId: job.id, trigger: 'auto_advance_backfill' },
    });
    advanced += 1;
  }
  if (advanced > 0) {
    console.log(`[recovery] auto-advance backfill queued ${advanced} screened job(s) for tailoring`);
    ctx.bus.emit({
      type: 'toast',
      level: 'info',
      message: `Auto-advance backfill: ${advanced} screened job(s) above your threshold queued for tailoring`,
    });
  }
  return advanced;
}

/** One-time repair: jobs skipped-with-scam-verdict become quarantined (findable). */
export function repairQuarantinedStatuses(ctx: AppContext): number {
  const rows = ctx.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'skipped'), eq(jobs.legitVerdict, 'scam')))
    .all();
  for (const j of rows) {
    const row = updateJob(ctx, j.id, { status: 'quarantined' });
    ctx.bus.emit({ type: 'job.scored', job: toJob(row) });
  }
  if (rows.length > 0) {
    console.log(`[recovery] moved ${rows.length} skipped-with-scam-verdict job(s) to quarantined`);
  }
  return rows.length;
}

/** Boot-time recovery: run before the queue runner starts claiming. */
export function runStartupRecovery(ctx: AppContext): void {
  try {
    reclaimStaleTasks(ctx, 0);
    recoverStuckTailoringJobs(ctx);
    repairQuarantinedStatuses(ctx);
    backfillAutoAdvance(ctx);
  } catch (err) {
    console.error('[recovery] startup recovery failed:', err);
  }
}

/** Periodic zombie sweep; returns a stop function. */
export function startZombieSweep(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    try {
      reclaimStaleTasks(ctx, STALE_CLAIM_MS);
      recoverStuckTailoringJobs(ctx);
      backfillAutoAdvance(ctx);
    } catch (err) {
      console.error('[recovery] zombie sweep failed:', err);
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
