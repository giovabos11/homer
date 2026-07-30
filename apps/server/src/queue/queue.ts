// SQLite-backed task queue (FR-1, PRD §6). Claim is an atomic
// UPDATE … WHERE state='pending' … RETURNING so a claimed task can never be
// double-run. Every task carries cursor_json so interrupted work resumes from
// where it left off.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { TaskState, TaskType } from '@shared/types';
import type { Db, DbHandle } from '../db/client';
import { taskQueue } from '../db/schema';
import type { SettingsStore } from '../settings';
import type { Clock } from './budgets';

export type TaskRow = typeof taskQueue.$inferSelect;

export interface EnqueueOptions {
  payload?: Record<string, unknown>;
  runAfter?: Date | null;
  /** Skip enqueue when an identical-type task is already pending/running. */
  dedupe?: boolean;
  cursor?: Record<string, unknown> | null;
}

const ACTIVE_STATES: TaskState[] = ['pending', 'running', 'paused', 'needs_human', 'waiting_session'];

export class TaskQueue {
  private db: Db;
  private sqlite: DbHandle['sqlite'];

  constructor(
    handle: DbHandle,
    private settings: SettingsStore,
    private opts: { maxAttempts: number; backoffBaseMs: number; backoffMaxMs: number },
    private clock: Clock = () => Date.now(),
  ) {
    this.db = handle.db;
    this.sqlite = handle.sqlite;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  enqueue(type: TaskType, options: EnqueueOptions = {}): TaskRow {
    if (options.dedupe) {
      const existing = this.db
        .select()
        .from(taskQueue)
        .where(and(eq(taskQueue.type, type), inArray(taskQueue.state, ['pending', 'running'])))
        .get();
      if (existing) return existing;
    }
    const now = this.nowIso();
    const row = this.db
      .insert(taskQueue)
      .values({
        type,
        payloadJson: JSON.stringify(options.payload ?? {}),
        state: 'pending',
        cursorJson: options.cursor ? JSON.stringify(options.cursor) : null,
        runAfter: options.runAfter ? options.runAfter.toISOString() : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return row;
  }

  /**
   * Atomically claim the next runnable pending task (FIFO, run_after respected).
   * Returns null when the queue is paused or nothing is runnable.
   */
  claim(): TaskRow | null {
    if (this.isPaused()) return null;
    const now = this.nowIso();
    const row = this.sqlite
      .prepare(
        `UPDATE task_queue SET state='running', updated_at=@now
         WHERE id = (
           SELECT id FROM task_queue
           WHERE state='pending' AND (run_after IS NULL OR run_after <= @now)
           ORDER BY id LIMIT 1
         ) AND state='pending'
         RETURNING *`,
      )
      .get({ now }) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.get(row.id as number);
  }

  get(id: number): TaskRow | null {
    return this.db.select().from(taskQueue).where(eq(taskQueue.id, id)).get() ?? null;
  }

  /** Persist a worker's resume cursor mid-run. */
  saveCursor(id: number, cursor: Record<string, unknown> | null): void {
    this.db
      .update(taskQueue)
      .set({ cursorJson: cursor ? JSON.stringify(cursor) : null, updatedAt: this.nowIso() })
      .where(eq(taskQueue.id, id))
      .run();
  }

  complete(id: number): TaskRow {
    return this.setState(id, 'done', { lastError: null });
  }

  /**
   * Record a failure. Retries with exponential backoff until attempts reach the
   * cap, then the task moves to failed.
   */
  fail(id: number, error: string): TaskRow {
    const task = this.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const attempts = task.attempts + 1;
    if (attempts >= this.opts.maxAttempts) {
      return this.setState(id, 'failed', { attempts, lastError: error });
    }
    const backoff = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** (attempts - 1));
    const jitter = Math.floor(Math.random() * 0.2 * backoff);
    return this.setState(id, 'pending', {
      attempts,
      lastError: error,
      runAfter: new Date(this.clock() + backoff + jitter).toISOString(),
    });
  }

  pauseTask(id: number): TaskRow {
    return this.setState(id, 'paused', {});
  }

  needsHuman(id: number, prompt: string): TaskRow {
    return this.setState(id, 'needs_human', { humanPrompt: prompt });
  }

  waitingSession(id: number, detail: string): TaskRow {
    return this.setState(id, 'waiting_session', { lastError: detail });
  }

  /** User completed the manual step → task resumes from its cursor. */
  resolveHuman(id: number): TaskRow {
    return this.setState(id, 'pending', { humanPrompt: null, runAfter: null });
  }

  /** Manual retry of a failed / stuck task (attempts reset). */
  retry(id: number): TaskRow {
    return this.setState(id, 'pending', { attempts: 0, lastError: null, runAfter: null });
  }

  /** Cancel: terminal 'failed' with an explicit marker (TaskState has no separate cancelled state). */
  cancel(id: number): TaskRow {
    return this.setState(id, 'failed', { lastError: 'Cancelled by user' });
  }

  // --- global pause flag (persisted so it survives restarts) ---

  isPaused(): boolean {
    return this.settings.getInternal('queuePaused', false);
  }

  /** Pause the queue; running tasks observe the flag and park themselves. */
  setPaused(paused: boolean): void {
    this.settings.setInternal('queuePaused', paused);
    if (!paused) {
      // Wake parked tasks: paused → pending (cursor kept → resume from it).
      this.db
        .update(taskQueue)
        .set({ state: 'pending', updatedAt: this.nowIso() })
        .where(eq(taskQueue.state, 'paused'))
        .run();
    }
  }

  list(limit = 100): TaskRow[] {
    return this.db.select().from(taskQueue).orderBy(desc(taskQueue.id)).limit(limit).all();
  }

  countActive(type?: TaskType): number {
    const rows = this.db
      .select({ n: sql<number>`count(*)` })
      .from(taskQueue)
      .where(
        type
          ? and(eq(taskQueue.type, type), inArray(taskQueue.state, ACTIVE_STATES))
          : inArray(taskQueue.state, ACTIVE_STATES),
      )
      .get();
    return rows?.n ?? 0;
  }

  private setState(id: number, state: TaskState, extra: Partial<TaskRow>): TaskRow {
    this.db
      .update(taskQueue)
      .set({ ...extra, state, updatedAt: this.nowIso() })
      .where(eq(taskQueue.id, id))
      .run();
    const row = this.get(id);
    if (!row) throw new Error(`Task ${id} not found`);
    return row;
  }
}
