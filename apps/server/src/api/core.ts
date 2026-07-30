// Health, connections, profile, artifacts (contract §Health & connections, §Profile & documents).
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { UserProfile } from '@shared/types';
import type { AppContext } from '../context';
import { safeJoin } from '../util/paths';
import { ApiError, parseBody } from './util';

const KEYED = new Set(['adzuna', 'usajobs']);

export function coreRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: ctx.version });
  });

  router.get('/connections', async (_req, res) => {
    res.json(await ctx.monitor.list());
  });

  router.post('/connections/:name/key', async (req, res) => {
    const name = req.params.name ?? '';
    if (!KEYED.has(name)) {
      throw new ApiError(400, 'validation_error', `Connection ${name} does not accept an API key (only: adzuna, usajobs)`);
    }
    const body = parseBody(z.object({ key: z.string().min(1), appId: z.string().optional() }), req);
    await ctx.vault.set(`apikey:${name}`, body.key);
    if (body.appId) await ctx.vault.set(`apikey:${name}:appId`, body.appId);
    ctx.monitor.invalidate();
    const connection = await ctx.monitor.get(name, true);
    if (connection) ctx.bus.emit({ type: 'connection.updated', connection });
    res.json(connection);
  });

  router.post('/connections/:name/check', async (req, res) => {
    const name = req.params.name ?? '';
    const connection = await ctx.monitor.get(name, true);
    if (!connection) throw new ApiError(404, 'not_found', `Unknown connection: ${name}`);
    ctx.bus.emit({ type: 'connection.updated', connection });
    res.json(connection);
  });

  router.get('/profile', (_req, res) => {
    res.json(readProfile(ctx));
  });

  // Markdown artifact viewer — safe-listed roots only (contract).
  router.get('/artifacts', (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) throw new ApiError(400, 'validation_error', 'path query parameter is required');
    const allowedRoots = ['documents', 'upskill'];
    const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const root = normalized.split('/')[0] ?? '';
    let abs: string;
    try {
      if (allowedRoots.includes(root)) {
        abs = safeJoin(ctx.repoRoot, normalized);
      } else {
        // Application archives + generated artifacts live under data/artifacts.
        abs = safeJoin(ctx.artifactsDir, normalized);
      }
    } catch {
      // safeJoin throws on traversal — that's client input, not a server fault.
      throw new ApiError(400, 'validation_error', `Path escapes the allowed roots: ${normalized}`);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new ApiError(404, 'not_found', `No artifact at ${normalized}`);
    }
    res.json({ path: normalized, markdown: fs.readFileSync(abs, 'utf8') });
  });

  return router;
}

/** Files that ship as placeholders; "[PLACEHOLDER" / "[YOUR_" tokens mean /setup has not run yet. */
const PROFILE_READY_FILES = ['CLAUDE.md', '.claude/skills/job-application-assistant/01-candidate-profile.md'];

/**
 * True once the candidate profile is populated: every profile file that exists
 * is free of the literal placeholder tokens "[PLACEHOLDER" and "[YOUR_"
 * (and at least one of the files exists at all).
 */
export function computeProfileReady(repoRoot: string): boolean {
  let sawAny = false;
  for (const rel of PROFILE_READY_FILES) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    sawAny = true;
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('[PLACEHOLDER') || text.includes('[YOUR_')) return false;
  }
  return sawAny;
}

/** Best-effort identity extraction from the populated CLAUDE.md / profile docs (FR-15). */
export function readProfile(ctx: AppContext): UserProfile {
  const settings = ctx.settings.get();
  const profile: UserProfile = {
    fullName: '',
    email: '',
    phone: '',
    location: '',
    links: [],
    documents: [],
    country: settings.country,
    profileReady: computeProfileReady(ctx.repoRoot),
  };

  const claudeMd = path.join(ctx.repoRoot, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    const md = fs.readFileSync(claudeMd, 'utf8');
    const grab = (re: RegExp) => re.exec(md)?.[1]?.trim() ?? '';
    profile.fullName = clean(grab(/\*\*Name:\*\*\s*([^\n]+)/));
    profile.email = clean(grab(/\*\*Email:\*\*\s*([^\n|]+)/));
    // Phone keeps its parenthesized area code — clean() would truncate "+1 (832) …" to "+1".
    profile.phone = grab(/\*\*Phone:\*\*\s*([^\n|]+)/).replace(/\*+/g, '').trim();
    profile.location = clean(grab(/\*\*Location:\*\*\s*([^\n(]+)/));
    for (const [label, url] of md.matchAll(/\*\*(Portfolio|GitHub|LinkedIn|Company)\*\*?:?\*{0,2}\s*(https?:\/\/\S+)/g)) {
      profile.links.push({ label: label ?? 'Link', url: (url ?? '').replace(/[|,]$/, '') });
    }
    if (profile.links.length === 0) {
      for (const [url] of md.matchAll(/(https?:\/\/(?:www\.)?(?:gii\.ooo|github\.com|linkedin\.com|rigaly\.com)\S*)/g)) {
        const u = (url ?? '').replace(/[|,)]+$/, '');
        if (!profile.links.some((l) => l.url === u)) profile.links.push({ label: labelFor(u), url: u });
      }
    }
  }

  const docsDir = path.join(ctx.repoRoot, 'documents');
  if (fs.existsSync(docsDir)) {
    const stack = [docsDir];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (!entry.name.startsWith('.')) {
          profile.documents.push({
            name: entry.name,
            path: path.relative(ctx.repoRoot, full).split(path.sep).join('/'),
            modifiedAt: fs.statSync(full).mtime.toISOString(),
          });
        }
      }
    }
    profile.documents.sort((a, b) => a.path.localeCompare(b.path));
  }
  return profile;
}

function clean(value: string): string {
  return value.replace(/\s*\(.*$/, '').replace(/\*+/g, '').trim();
}

function labelFor(url: string): string {
  if (url.includes('github.com')) return 'GitHub';
  if (url.includes('linkedin.com')) return 'LinkedIn';
  if (url.includes('rigaly.com')) return 'Company';
  return 'Portfolio';
}
