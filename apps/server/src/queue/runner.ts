// Queue runner: polls for claimable tasks and dispatches them to the worker
// registry. Single-flight (global concurrency 1) — polite by design; the
// per-source token buckets inside the discovery worker handle finer pacing.
import type { AppContext } from '../context';
import { PauseRequested, NeedsHuman, WaitingSession, getWorker } from '../workers/registry';
import { toQueueTask } from '../db/serialize';

export class QueueRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private ctx: AppContext) {}

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.ctx.config.queue.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Process at most one task; used by the interval and directly by tests. */
  async tick(): Promise<boolean> {
    if (this.running || this.stopped) return false;
    const task = this.ctx.queue.claim();
    if (!task) return false;
    this.running = true;
    const emitTask = (id: number) => {
      const row = this.ctx.queue.get(id);
      if (row) this.ctx.bus.emit({ type: 'queue.updated', task: toQueueTask(row) });
    };
    emitTask(task.id);
    try {
      const worker = getWorker(task.type);
      if (!worker) {
        this.ctx.queue.fail(task.id, `No worker registered for type ${task.type}`);
      } else {
        await worker.run({
          ctx: this.ctx,
          task,
          paused: () => this.ctx.queue.isPaused() || this.stopped,
          saveCursor: (cursor) => this.ctx.queue.saveCursor(task.id, cursor),
        });
        this.ctx.queue.complete(task.id);
      }
    } catch (err) {
      if (err instanceof PauseRequested) {
        this.ctx.queue.pauseTask(task.id);
      } else if (err instanceof NeedsHuman) {
        const row = this.ctx.queue.needsHuman(task.id, err.prompt);
        this.ctx.bus.emit({ type: 'task.needs_human', task: toQueueTask(row) });
      } else if (err instanceof WaitingSession) {
        this.ctx.queue.waitingSession(task.id, err.detail);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.ctx.queue.fail(task.id, message);
      }
    } finally {
      emitTask(task.id);
      this.running = false;
    }
    return true;
  }

  /** Drain until nothing is claimable (tests / simulate demos). */
  async drain(maxTasks = 50): Promise<number> {
    let n = 0;
    while (n < maxTasks && (await this.tick())) n += 1;
    return n;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
