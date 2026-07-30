// Health, connections, profile, artifacts (contract §Health & connections, §Profile & documents).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { UserProfile } from '@shared/types';
import type { AppContext } from '../context';
import { safeJoin } from '../util/paths';
import { ApiError, parseBody } from './util';

const KEYED = new Set(['adzuna', 'usajobs']);

const profilePatchSchema = z
  .object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(200),
    // Loose phone check: leading + or digit, then digits with common separators.
    phone: z.string().regex(/^[+\d][\d\s().-]{6,24}$/, 'Not a recognizable phone number'),
  })
  .partial()
  .strict();

/**
 * STRICT safe-list for the profile file editor:
 *  - documents/** with a .md or .txt extension
 *  - .claude/skills/job-application-assistant/<file>.md
 *  - exactly CLAUDE.md
 * Everything else (traversal, absolute paths, other extensions) → 400.
 */
export function resolveProfileFilePath(repoRoot: string, rawPath: string): { rel: string; abs: string } {
  const rel = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const bad = () => new ApiError(400, 'validation_error', `Path is not an editable profile file: ${rawPath}`);
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw bad();
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) throw bad();

  const allowed =
    rel === 'CLAUDE.md' ||
    (rel.startsWith('documents/') && /\.(md|txt)$/i.test(rel)) ||
    /^\.claude\/skills\/job-application-assistant\/[^/]+\.md$/.test(rel);
  if (!allowed) throw bad();

  let abs: string;
  try {
    abs = safeJoin(repoRoot, rel);
  } catch {
    throw bad();
  }
  return { rel, abs };
}

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

  // Gmail test-connection: a tiny headless AgentRunner call (haiku) that
  // reports whether the claude.ai Gmail MCP tools are reachable. Headless
  // sessions usually cannot see them (Gmail is session-only by design, D4) —
  // the probe result explains either way and updates the connection card.
  router.post('/connections/gmail/probe', async (_req, res) => {
    let available = false;
    let toolCount = 0;
    try {
      const result = await ctx.runner.run({
        prompt: [
          'List which tools matching mcp__claude_ai_Gmail__* are available to you',
          'in this session. Do not call any of them.',
          'Reply with a single JSON object and nothing else, matching:',
          '{ "available": boolean, "toolCount": number }',
        ].join('\n'),
        cwd: ctx.repoRoot,
        model: 'haiku',
        allowedTools: ['mcp__claude_ai_Gmail__*'],
        timeoutMs: 90000,
      });
      const parsed = z
        .object({ available: z.boolean(), toolCount: z.number().int().min(0).default(0) })
        .safeParse(result.structured);
      if (parsed.success) {
        available = parsed.data.available && parsed.data.toolCount > 0;
        toolCount = parsed.data.toolCount;
      }
    } catch {
      available = false;
    }

    const detail = available
      ? `Gmail MCP reachable — ${toolCount} tool(s) available`
      : 'Not available in headless sessions — email tasks run when you have an interactive Claude session open (/email-bridge)';
    ctx.settings.setInternal('gmailProbe', { ok: available, detail, at: new Date().toISOString() });
    ctx.monitor.invalidate();
    const connection = await ctx.monitor.get('gmail', true);
    if (connection) ctx.bus.emit({ type: 'connection.updated', connection });
    res.json({ connection, available, toolCount, detail });
  });

  router.get('/profile', (_req, res) => {
    res.json(readProfile(ctx));
  });

  // Contact overrides — stored as internal settings, preferred over values
  // extracted from the profile files, so they work even before /setup runs.
  router.patch('/profile', (req, res) => {
    const body = parseBody(profilePatchSchema, req);
    if (body.name !== undefined) ctx.settings.setInternal('userName', body.name.trim());
    if (body.email !== undefined) ctx.settings.setInternal('userEmail', body.email.trim());
    if (body.phone !== undefined) ctx.settings.setInternal('userPhone', body.phone.trim());
    res.json(readProfile(ctx));
  });

  // Profile file editor (dashboard Profile modal) — strict safe-list only.
  router.get('/profile/files', (req, res) => {
    const { rel, abs } = resolveProfileFilePath(ctx.repoRoot, String(req.query.path ?? ''));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new ApiError(404, 'not_found', `No profile file at ${rel}`);
    }
    res.json({ path: rel, content: fs.readFileSync(abs, 'utf8') });
  });

  router.put('/profile/files', (req, res) => {
    const body = parseBody(z.object({ path: z.string().min(1), content: z.string() }), req);
    const { rel, abs } = resolveProfileFilePath(ctx.repoRoot, body.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content, 'utf8');
    // profileReady recomputes on the next GET /api/profile (same as setup);
    // documents/ edits additionally wake the file watcher's profile re-sync.
    ctx.bus.emit({ type: 'toast', level: 'info', message: `Saved ${rel}` });
    res.json({ ok: true });
  });

  // Rewrite the job-scraper search queries from the current profile
  // (regen_queries worker, modelScraper). Deduped like discovery.
  router.post('/profile/regenerate-queries', (_req, res) => {
    const requestId = crypto.randomUUID();
    ctx.queue.enqueue('regen_queries', { dedupe: true, payload: { requestId } });
    res.json({ requestId });
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

  // Dashboard contact overrides (PATCH /api/profile) win over extracted values.
  const overrideName = ctx.settings.getInternal<string | null>('userName', null);
  const overrideEmail = ctx.settings.getInternal<string | null>('userEmail', null);
  const overridePhone = ctx.settings.getInternal<string | null>('userPhone', null);
  if (overrideName) profile.fullName = overrideName;
  if (overrideEmail) profile.email = overrideEmail;
  if (overridePhone) profile.phone = overridePhone;

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
