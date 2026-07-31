// Danger reset (contract §reset — FR-28, PRD D9).
// Preview mode returns exactly what will be deleted; execute requires the typed
// confirmation string "RESET". Scopes:
//   db        → wipe all data tables (settings/budget seeds re-applied)
//   artifacts → delete everything under data/artifacts
//   profile   → restore the upstream profile placeholder files from git HEAD
//               (upstream /reset "profile" scope semantics)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { discoverSkills } from '../sources/skills';
import type { AppContext } from '../context';
import { ApiError, parseBody } from './util';

const SCOPES = ['db', 'artifacts', 'profile'] as const;
type Scope = (typeof SCOPES)[number];

const DATA_TABLES = [
  'jobs', 'applications', 'emails', 'followups', 'schedule_events', 'prep_tasks',
  'skills_progress', 'task_queue', 'source_budgets', 'credentials_meta', 'connections', 'feedback',
  // Standing answers are normal data: a db reset clears them, exactly like the
  // rest of the pipeline state (documented in apps/CONTRACT.md).
  'standing_answers',
];

/** Upstream profile files restored (to their tracked placeholder state) by the profile scope. */
const PROFILE_FILES = [
  '.claude/skills/job-application-assistant/01-candidate-profile.md',
  '.claude/skills/job-application-assistant/02-behavioral-profile.md',
  '.claude/skills/job-application-assistant/05-cv-templates.md',
  '.claude/skills/job-application-assistant/07-interview-prep.md',
  'CLAUDE.md',
];

const bodySchema = z.object({
  preview: z.boolean().optional(),
  confirmation: z.string().optional(),
  scopes: z.array(z.enum(SCOPES)).min(1),
});

function listArtifacts(dir: string, base: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) out.push(...listArtifacts(full, rel));
    else out.push(rel);
  }
  return out;
}

export function buildPreview(ctx: AppContext, scopes: Scope[]): string[] {
  const preview: string[] = [];
  if (scopes.includes('db')) {
    for (const table of DATA_TABLES) {
      const n = (ctx.handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      preview.push(`db: wipe table ${table} (${n} row${n === 1 ? '' : 's'})`);
    }
    preview.push('db: settings table is kept (re-seeded defaults stay available)');
  }
  if (scopes.includes('artifacts')) {
    const files = listArtifacts(ctx.artifactsDir, 'data/artifacts');
    if (files.length === 0) preview.push('artifacts: (empty — nothing to delete)');
    for (const f of files) preview.push(`artifacts: delete ${f}`);
  }
  if (scopes.includes('profile')) {
    for (const f of PROFILE_FILES) {
      preview.push(`profile: restore ${f} from git HEAD (placeholder state)`);
    }
    preview.push('profile: documents/ is NOT touched (use upstream /reset documents for that)');
  }
  return preview;
}

export function executeReset(ctx: AppContext, scopes: Scope[]): void {
  if (scopes.includes('db')) {
    const wipe = ctx.handle.sqlite.transaction(() => {
      // Tables are wiped in declaration order, which is parent-before-child
      // (applications → jobs etc.); defer FK checks to commit, when all rows are gone.
      ctx.handle.sqlite.pragma('defer_foreign_keys = ON');
      for (const table of DATA_TABLES) ctx.handle.sqlite.prepare(`DELETE FROM ${table}`).run();
      ctx.handle.sqlite.prepare(`DELETE FROM sqlite_sequence`).run();
    });
    wipe();
    // Re-seed source budgets for installed skills.
    for (const skill of discoverSkills(ctx.repoRoot)) ctx.budgets.ensure(skill.source);
    ctx.settings.setInternal('queuePaused', false);
  }
  if (scopes.includes('artifacts')) {
    if (fs.existsSync(ctx.artifactsDir)) {
      fs.rmSync(ctx.artifactsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(ctx.artifactsDir, { recursive: true });
  }
  if (scopes.includes('profile')) {
    const existing = PROFILE_FILES.filter((f) => fs.existsSync(path.join(ctx.repoRoot, f)));
    try {
      execFileSync('git', ['checkout', 'HEAD', '--', ...existing], {
        cwd: ctx.repoRoot,
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch (err) {
      throw new ApiError(
        500,
        'reset_failed',
        `git restore of profile files failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function resetRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/reset', (req, res) => {
    const body = parseBody(bodySchema, req);

    if (body.preview) {
      res.json({ preview: buildPreview(ctx, body.scopes) });
      return;
    }
    if (body.confirmation !== 'RESET') {
      throw new ApiError(400, 'confirmation_required', 'Type RESET (all caps) in the confirmation field to execute');
    }
    executeReset(ctx, body.scopes);
    ctx.bus.emit({
      type: 'toast',
      level: 'warning',
      message: `Reset executed (scopes: ${body.scopes.join(', ')})`,
    });
    res.json({ ok: true });
  });

  return router;
}
