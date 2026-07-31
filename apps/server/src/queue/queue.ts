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
  /** Claim order: higher first, FIFO within a band (10 user, 5 auto-advance, 0 bulk). */
  priority?: number;
}

/** Enqueue priority bands (PRD §11). */
export const PRIORITY = { user: 10, autoAdvance: 5, bulk: 0 } as const;

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
        priority: options.priority ?? 0,
        runAfter: options.runAfter ? options.runAfter.toISOString() : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return row;
  }

  /**
   * Atomically claim the next runnable pending task (priority DESC, then FIFO;
   * run_after respected). `types` restricts the claim to those task types —
   * how the runner keeps its concurrency lanes (agent pool vs. serialized
   * apply/discover) apart. Returns null when the queue is paused or nothing
   * claimable matches.
   */
  claim(types?: TaskType[]): TaskRow | null {
    if (this.isPaused()) return null;
    if (types && types.length === 0) return null;
    const now = this.nowIso();
    // types come from the closed TaskType enum (runner lane constants), so
    // inlining them as quoted literals is safe and keeps the binding simple.
    const typeFilter = types ? `AND type IN (${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})` : '';
    const row = this.sqlite
      .prepare(
        `UPDATE task_queue SET state='running', updated_at=@now
         WHERE id = (
           SELECT id FROM task_queue
           WHERE state='pending' AND (run_after IS NULL OR run_after <= @now)
           ${typeFilter}
           ORDER BY priority DESC, id LIMIT 1
         ) AND state='pending'
         RETURNING *`,
      )
      .get({ now }) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.get(row.id as number);
  }

  /**
   * Approximate queue position: how many running + claim-ordered-earlier
   * pending tasks stand between this task and execution. 0 = next up.
   */
  positionOf(id: number): number {
    const task = this.get(id);
    if (!task || task.state !== 'pending') return 0;
    const row = this.sqlite
      .prepare(
        `SELECT count(*) AS n FROM task_queue
         WHERE state='running'
            OR (state='pending' AND id <> @id
                AND (priority > @priority OR (priority = @priority AND id < @id)))`,
      )
      .get({ id: task.id, priority: task.priority }) as { n: number };
    return row.n;
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

  /**
   * Requeue zombie claims: 'running' rows whose updated_at is older than
   * `olderThanMs` (dev-server restarts kill workers mid-task and the claim
   * never expires on its own). Attempts are preserved; lastError notes the
   * reclaim. Pass 0 at boot — before the runner starts, nothing can
   * legitimately be running.
   */
  reclaimStale(olderThanMs: number): TaskRow[] {
    const now = this.nowIso();
    const cutoff = new Date(this.clock() - olderThanMs).toISOString();
    const rows = this.sqlite
      .prepare(
        `UPDATE task_queue
         SET state='pending', run_after=NULL, last_error='reclaimed after stale run', updated_at=@now
         WHERE state='running' AND updated_at <= @cutoff
         RETURNING id`,
      )
      .all({ now, cutoff }) as { id: number }[];
    return rows.map((r) => this.get(r.id)).filter((r): r is TaskRow => r != null);
  }

  /**
   * Bulk retry of failed tasks (optionally one type): attempts reset to 0,
   * back to pending immediately. Explicit user cancellations stay cancelled.
   */
  retryAllFailed(type?: TaskType): TaskRow[] {
    const now = this.nowIso();
    const rows = this.sqlite
      .prepare(
        `UPDATE task_queue
         SET state='pending', attempts=0, last_error=NULL, run_after=NULL, updated_at=@now
         WHERE state='failed'
           AND (last_error IS NULL OR last_error <> 'Cancelled by user')
           ${type ? 'AND type=@type' : ''}
         RETURNING id`,
      )
      .all(type ? { now, type } : { now }) as { id: number }[];
    return rows.map((r) => this.get(r.id)).filter((r): r is TaskRow => r != null);
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
