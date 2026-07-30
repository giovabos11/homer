// Per-source politeness budgets: a token bucket persisted in source_budgets (FR-1).
// Tokens refill continuously at refill_per_hour up to capacity; take() spends one.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sourceBudgets } from '../db/schema';
import type { BudgetSpec } from '../config';

export type Clock = () => number; // ms epoch, injectable for tests

export interface TakeResult {
  ok: boolean;
  /** When tokens will next be available (ISO), present when ok=false. */
  nextRun: string | null;
  remaining: number;
}

export class BudgetManager {
  constructor(
    private db: Db,
    private defaults: BudgetSpec,
    private perSource: Record<string, BudgetSpec> = {},
    private clock: Clock = () => Date.now(),
  ) {}

  /** Ensure a budget row exists for a source (called when skills are discovered). */
  ensure(source: string): void {
    const existing = this.db.select().from(sourceBudgets).where(eq(sourceBudgets.source, source)).get();
    if (existing) return;
    const spec = this.perSource[source] ?? this.defaults;
    this.db
      .insert(sourceBudgets)
      .values({
        source,
        tokens: spec.capacity,
        capacity: spec.capacity,
        refillPerHour: spec.refillPerHour,
        lastRefill: new Date(this.clock()).toISOString(),
        health: 'ok',
        enabled: 1,
      })
      .run();
  }

  /** Refill by elapsed time, then try to spend `cost` tokens. */
  take(source: string, cost = 1): TakeResult {
    this.ensure(source);
    const row = this.db.select().from(sourceBudgets).where(eq(sourceBudgets.source, source)).get()!;
    const now = this.clock();
    const last = row.lastRefill ? Date.parse(row.lastRefill) : now;
    const elapsedHours = Math.max(0, (now - last) / 3_600_000);
    let tokens = Math.min(row.capacity, row.tokens + elapsedHours * row.refillPerHour);

    if (row.enabled !== 1) {
      return { ok: false, nextRun: null, remaining: Math.floor(tokens) };
    }

    if (tokens >= cost) {
      tokens -= cost;
      this.db
        .update(sourceBudgets)
        .set({
          tokens,
          lastRefill: new Date(now).toISOString(),
          lastRun: new Date(now).toISOString(),
          nextRun: null,
        })
        .where(eq(sourceBudgets.source, source))
        .run();
      return { ok: true, nextRun: null, remaining: Math.floor(tokens) };
    }

    const deficit = cost - tokens;
    const hoursUntil = row.refillPerHour > 0 ? deficit / row.refillPerHour : Number.POSITIVE_INFINITY;
    const nextRun = Number.isFinite(hoursUntil) ? new Date(now + hoursUntil * 3_600_000).toISOString() : null;
    this.db
      .update(sourceBudgets)
      .set({ tokens, lastRefill: new Date(now).toISOString(), nextRun })
      .where(eq(sourceBudgets.source, source))
      .run();
    return { ok: false, nextRun, remaining: Math.floor(tokens) };
  }

  setHealth(source: string, health: 'ok' | 'degraded' | 'down'): void {
    this.ensure(source);
    this.db.update(sourceBudgets).set({ health }).where(eq(sourceBudgets.source, source)).run();
  }

  setEnabled(source: string, enabled: boolean): void {
    this.ensure(source);
    this.db.update(sourceBudgets).set({ enabled: enabled ? 1 : 0 }).where(eq(sourceBudgets.source, source)).run();
  }

  list() {
    return this.db.select().from(sourceBudgets).all();
  }
}
