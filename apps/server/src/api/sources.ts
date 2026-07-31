// Discovery sources (contract §Search & queue).
//
// `source_budgets.enabled` is the RUNTIME AUTHORITY for scheduled discovery.
// The SKILL.md `enabled:` frontmatter only seeds the flag the first time a
// source is seen (src/context.ts), so a dashboard toggle is never silently
// reverted by a file on disk at the next boot.
//
// Key-gated sources (adzuna, usajobs) stay excluded while their API key is
// missing, whatever the toggle says — surfaced as a reason, not silence.
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { SourceBudget } from '@shared/types';
import { connections, sourceBudgets } from '../db/schema';
import { toQueueTask, toSourceBudget } from '../db/serialize';
import { discoverSkills } from '../sources/skills';
import type { AppContext } from '../context';
import { ApiError, parseBody } from './util';

/** Sources that cannot run without an API key in the vault. */
export const KEY_GATED_SOURCES = ['adzuna', 'usajobs'];

/** True when a key-gated source has no key stored (sync: uses the cached connection row). */
function missingKey(ctx: AppContext, source: string): boolean {
  if (!KEY_GATED_SOURCES.includes(source)) return false;
  const row = ctx.db.select().from(connections).where(eq(connections.name, source)).get();
  return !row || row.status !== 'ok';
}

/** Budget rows enriched with why a source may still not run. */
export function listSources(ctx: AppContext): SourceBudget[] {
  const installed = new Set(discoverSkills(ctx.repoRoot).map((s) => s.source));
  return ctx.budgets.list().map((row) => {
    const dto = toSourceBudget(row);
    const keyGated = KEY_GATED_SOURCES.includes(dto.source);
    let blockedReason: string | null = null;
    if (keyGated && missingKey(ctx, dto.source)) blockedReason = 'Needs an API key before it can run';
    else if (!installed.has(dto.source) && !keyGated) blockedReason = 'Portal skill not installed';
    return { ...dto, keyGated, blockedReason };
  });
}

/**
 * Sources scheduled discovery may actually use right now: enabled by the user
 * and not key-gated-without-a-key. ("Skill not installed" is a display-only
 * reason — the discovery worker already iterates installed skills.)
 */
export function activeSources(ctx: AppContext): string[] {
  return listSources(ctx)
    .filter((s) => s.enabled && !(s.keyGated && missingKey(ctx, s.source)))
    .map((s) => s.source);
}

export function sourceRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/sources', (_req, res) => {
    res.json(listSources(ctx));
  });

  router.patch('/sources/:source', async (req, res) => {
    const source = String(req.params.source ?? '');
    const body = parseBody(z.object({ enabled: z.boolean() }), req);
    const existing = ctx.db.select().from(sourceBudgets).where(eq(sourceBudgets.source, source)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No discovery source ${source}`);

    ctx.budgets.setEnabled(source, body.enabled);
    const updated = listSources(ctx).find((s) => s.source === source)!;

    // The queue snapshot carries budgets, so the panel updates live.
    ctx.bus.emit({
      type: 'queue.snapshot',
      tasks: ctx.queue.list().map(toQueueTask),
      budgets: listSources(ctx),
      paused: ctx.queue.isPaused(),
      nextRuns: ctx.scheduler.nextRuns(),
    });
    const connection = await ctx.monitor.get(source).catch(() => null);
    if (connection) ctx.bus.emit({ type: 'connection.updated', connection });
    res.json(updated);
  });

  return router;
}
