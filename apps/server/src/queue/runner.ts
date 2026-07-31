// Queue runner: polls for claimable tasks and dispatches them to the worker
// registry. Bounded slot pool: up to `queueConcurrency` (settings, 1-4)
// agent-bound tasks run in parallel, while `apply` (one headed browser) and
// `discover` (its own politeness pacing) are each serialized to a single
// flight — an apply task may still run alongside agent tasks. Claims stay
// atomic (UPDATE … RETURNING with a type filter), and each slot is
// error-isolated: one crashing task can never take down the loop.
import { eq } from 'drizzle-orm';
import type { TaskType } from '@shared/types';
import type { AppContext } from '../context';
import type { AgentRunner } from '../agent/types';
import { jobs } from '../db/schema';
import { PauseRequested, NeedsHuman, WaitingSession, getWorker } from '../workers/registry';
import { toQueueTask } from '../db/serialize';
import type { TaskRow } from './queue';

/** Serialized lanes: exactly one task of these types in flight at a time. */
const SERIALIZED_LANES: TaskType[] = ['apply', 'discover'];

/** Every non-serialized type shares the agent slot pool. */
const AGENT_TYPES: TaskType[] = [
  'score', 'tailor', 'prep_guide', 'email_scan', 'email_send', 'followup',
  'feedback', 'regen_queries', 'setup', 'ask', 'profile_sync',
];

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 4;

/** Wrap an AgentRunner so every call it makes inherits the task's abort signal. */
function withSignal(runner: AgentRunner, signal: AbortSignal): AgentRunner {
  return { run: (opts) => runner.run({ ...opts, signal: opts.signal ?? signal }) };
}

export class QueueRunner {
  private timer: NodeJS.Timeout | null = null;
  /** Tasks currently in flight in this process: id → type. */
  private inFlight = new Map<number, TaskType>();
  private stopped = false;

  constructor(private ctx: AppContext) {}

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => this.fillSlots(), this.ctx.config.queue.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Configured agent-pool size, clamped to the supported band. */
  private concurrency(): number {
    const n = Number(this.ctx.settings.get().queueConcurrency);
    if (!Number.isFinite(n)) return 2;
    return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n)));
  }

  /** Task types allowed to claim right now, given what is already in flight. */
  private claimableTypes(): TaskType[] {
    const busy = [...this.inFlight.values()];
    const allowed: TaskType[] = [];
    if (busy.filter((t) => AGENT_TYPES.includes(t)).length < this.concurrency()) {
      allowed.push(...AGENT_TYPES);
    }
    for (const lane of SERIALIZED_LANES) {
      if (!busy.includes(lane)) allowed.push(lane);
    }
    return allowed;
  }

  /** Claim one task if a slot is free. Registers it in flight before returning. */
  private claimNext(): TaskRow | null {
    if (this.stopped) return null;
    const types = this.claimableTypes();
    if (types.length === 0) return null;
    const task = this.ctx.queue.claim(types);
    if (!task) return null;
    this.inFlight.set(task.id, task.type as TaskType);
    return task;
  }

  /**
   * Fill every free slot and dispatch the claimed tasks without awaiting them —
   * this is what the poll interval calls, and where parallelism comes from.
   * Returns the number of tasks started.
   */
  fillSlots(): number {
    let started = 0;
    for (;;) {
      const task = this.claimNext();
      if (!task) return started;
      started += 1;
      void this.runTask(task);
    }
  }

  /** Claim and fully process at most one task (tests / drain use this). */
  async tick(): Promise<boolean> {
    const task = this.claimNext();
    if (!task) return false;
    await this.runTask(task);
    return true;
  }

  /**
   * Run one claimed task to a terminal/parked state. Never throws — worker
   * failures become task states, and even bookkeeping errors are contained so
   * a single slot can never kill the loop or leak its in-flight entry.
   */
  private async runTask(task: TaskRow): Promise<void> {
    const emitTask = (id: number) => {
      const row = this.ctx.queue.get(id);
      if (row) this.ctx.bus.emit({ type: 'queue.updated', task: toQueueTask(row) });
    };
    // Per-task cancellation: every agent call this worker makes runs under the
    // same signal, so cancelling kills the spawned CLI instead of orphaning it.
    const controller = this.ctx.cancellations.register(task.id);
    const scopedCtx: AppContext = { ...this.ctx, runner: withSignal(this.ctx.runner, controller.signal) };
    try {
      emitTask(task.id);
      try {
        const worker = getWorker(task.type);
        if (!worker) {
          this.ctx.queue.fail(task.id, `No worker registered for type ${task.type}`);
        } else {
          await worker.run({
            ctx: scopedCtx,
            task,
            paused: () => this.ctx.queue.isPaused() || this.stopped,
            saveCursor: (cursor) => this.ctx.queue.saveCursor(task.id, cursor),
            signal: controller.signal,
          });
          if (controller.signal.aborted) this.finishCancelled(task);
          else this.ctx.queue.complete(task.id);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          this.finishCancelled(task);
        } else if (err instanceof PauseRequested) {
          this.ctx.queue.pauseTask(task.id);
        } else if (err instanceof NeedsHuman) {
          if (err.payload) this.ctx.queue.mergePayload(task.id, err.payload);
          const row = this.ctx.queue.needsHuman(task.id, err.prompt);
          this.ctx.bus.emit({ type: 'task.needs_human', task: toQueueTask(row) });
        } else if (err instanceof WaitingSession) {
          this.ctx.queue.waitingSession(task.id, err.detail);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.ctx.queue.fail(task.id, message);
        }
      }
      emitTask(task.id);
    } catch (err) {
      // State bookkeeping itself failed — log and move on; the zombie sweep
      // reclaims the task if it was left 'running'.
      console.error(`[runner] task ${task.id} (${task.type}) bookkeeping failed:`, err);
    } finally {
      this.ctx.cancellations.release(task.id);
      this.inFlight.delete(task.id);
    }
  }

  /**
   * A cancelled task keeps the 'Cancelled by user' marker (so bulk retry skips
   * it) and leaves no half-finished pipeline state behind: a job abandoned
   * mid-tailor goes back to 'screened' so it can be re-queued cleanly.
   */
  private finishCancelled(task: TaskRow): void {
    this.ctx.queue.cancel(task.id);
    if (task.type !== 'tailor') return;
    try {
      const payload = JSON.parse(task.payloadJson) as { jobId?: number };
      if (payload.jobId == null) return;
      const job = this.ctx.db.select().from(jobs).where(eq(jobs.id, payload.jobId)).get();
      if (job?.status === 'tailoring') {
        this.ctx.db.update(jobs).set({ status: 'screened' }).where(eq(jobs.id, payload.jobId)).run();
      }
    } catch {
      /* rollback is best-effort; the recovery sweep is the backstop */
    }
  }

  /** Drain until nothing is claimable (tests / simulate demos). Serial by design. */
  async drain(maxTasks = 50): Promise<number> {
    let n = 0;
    while (n < maxTasks && (await this.tick())) n += 1;
    return n;
  }

  /** Number of tasks this process is running right now (all lanes). */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
