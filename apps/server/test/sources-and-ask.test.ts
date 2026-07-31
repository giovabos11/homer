// Per-source discovery toggles (source_budgets.enabled is the runtime
// authority), the Assistant chat's scoped file-edit safe-list, and feedback
// history deletion.
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, feedback, sourceBudgets } from '../src/db/schema';
import { activeSources, listSources } from '../src/api/sources';
import { ASK_ALLOWED_TOOLS, ASK_EDITABLE_PATTERNS, isAskEditable, repoRelative } from '../src/workers/ask';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

describe('discovery source toggles', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: true, repoRoot: repo.root });
    app = makeApp(world);
    // Two sources as if seeded from SKILL.md frontmatter: one on, one off.
    world.ctx.budgets.ensure('freehire');
    world.ctx.budgets.setEnabled('freehire', true);
    world.ctx.budgets.ensure('jobindex'); // Danish portal, frontmatter-disabled
    world.ctx.budgets.setEnabled('jobindex', false);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  it('a new source seeds from frontmatter exactly once; user choice wins afterwards', () => {
    // ensure() reports creation — the only moment frontmatter may seed enabled.
    expect(world.ctx.budgets.ensure('freehire')).toBe(false);
    expect(world.ctx.budgets.ensure('brand_new_portal')).toBe(true);
    world.ctx.budgets.setEnabled('brand_new_portal', false);
    // A later boot calls ensure() again and must NOT re-seed.
    expect(world.ctx.budgets.ensure('brand_new_portal')).toBe(false);
    expect(world.ctx.budgets.isEnabled('brand_new_portal')).toBe(false);
  });

  it('PATCH /api/sources/:source persists and filters scheduled discovery', async () => {
    expect(activeSources(world.ctx)).toContain('freehire');
    await request(app).patch('/api/sources/freehire').send({ enabled: false }).expect(200);
    expect(activeSources(world.ctx)).not.toContain('freehire');
    expect(world.ctx.db.select().from(sourceBudgets).where(eq(sourceBudgets.source, 'freehire')).get()!.enabled).toBe(0);

    // Turning a frontmatter-disabled portal ON is allowed — the DB is authority.
    await request(app).patch('/api/sources/jobindex').send({ enabled: true }).expect(200);
    expect(activeSources(world.ctx)).toContain('jobindex');

    await request(app).patch('/api/sources/not-a-source').send({ enabled: true }).expect(404);
    await request(app).patch('/api/sources/freehire').send({ enabled: 'yes' }).expect(400);
  });

  it('a key-gated source stays excluded when enabled without a key, with a reason', async () => {
    world.ctx.budgets.ensure('adzuna');
    await request(app).patch('/api/sources/adzuna').send({ enabled: true }).expect(200);
    const adzuna = listSources(world.ctx).find((s) => s.source === 'adzuna')!;
    expect(adzuna.enabled).toBe(true);
    expect(adzuna.keyGated).toBe(true);
    expect(adzuna.blockedReason).toContain('API key');
    expect(activeSources(world.ctx)).not.toContain('adzuna');

    // Once the connection reports a stored key it becomes usable.
    world.ctx.db
      .insert(connections)
      .values({ name: 'adzuna', status: 'ok', detail: 'key', lastOk: null })
      .onConflictDoUpdate({ target: connections.name, set: { status: 'ok' } })
      .run();
    expect(activeSources(world.ctx)).toContain('adzuna');
  });

  it('the queue snapshot carries the toggle state for the UI', async () => {
    const res = await request(app).get('/api/queue').expect(200);
    const freehire = res.body.budgets.find((b: { source: string }) => b.source === 'freehire');
    expect(freehire.enabled).toBe(true);
    const jobindex = res.body.budgets.find((b: { source: string }) => b.source === 'jobindex');
    expect(jobindex.enabled).toBe(false);
  });
});

describe('assistant chat file-edit safe-list', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  it('the safe-list covers the profile files and the scraper queries, nothing else', () => {
    expect(ASK_EDITABLE_PATTERNS.length).toBeGreaterThan(0);
    expect(isAskEditable('CLAUDE.md')).toBe(true);
    expect(isAskEditable('documents/cv/notes.md')).toBe(true);
    expect(isAskEditable('.claude/skills/job-application-assistant/04-job-evaluation.md')).toBe(true);
    expect(isAskEditable('.claude/skills/job-scraper/search-queries.md')).toBe(true);
    expect(isAskEditable('apps/server/src/index.ts')).toBe(false);
    expect(isAskEditable('.agents/skills/freehire-search/SKILL.md')).toBe(false);
    expect(repoRelative(repo.root, path.join(repo.root, '..', 'escape.md'))).toBeNull();
  });

  it('the ask run is given path-scoped edit permissions and a no-prompt system note', async () => {
    await request(app).post('/api/ask').send({ prompt: 'tighten my search queries' }).expect(200);
    await world.runner.drain();
    const call = world.mockAgent.calls.at(-1)!;
    expect(call.allowedTools).toEqual(ASK_ALLOWED_TOOLS);
    expect(call.allowedTools).toContain('Edit(.claude/skills/job-scraper/search-queries.md)');
    expect(call.allowedTools?.some((t) => t.startsWith('Edit(apps'))).toBe(false);
    expect(call.appendSystemPrompt).toContain('no interactive permission prompt');
  });

  it('an in-list edit is reported; an out-of-list write is reverted', async () => {
    const inList = path.join(repo.root, '.claude', 'skills', 'job-scraper');
    fs.mkdirSync(inList, { recursive: true });
    fs.writeFileSync(path.join(inList, 'search-queries.md'), '# queries\n', 'utf8');
    const outOfList = path.join(repo.root, 'apps', 'server', 'src');
    fs.mkdirSync(outOfList, { recursive: true });
    fs.writeFileSync(path.join(outOfList, 'index.ts'), 'ORIGINAL', 'utf8');

    // Script an agent turn that "edits" both files, mid-stream, like the CLI does.
    world.ctx.runner = {
      run: async (opts) => {
        opts.onEvent?.({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: '.claude/skills/job-scraper/search-queries.md' } },
              { type: 'tool_use', name: 'Write', input: { file_path: 'apps/server/src/index.ts' } },
            ],
          },
        });
        // The out-of-list write "happens" after the announcement.
        fs.writeFileSync(path.join(outOfList, 'index.ts'), 'HIJACKED', 'utf8');
        return { text: 'done', sessionId: 'sess-1' };
      },
    };

    await request(app).post('/api/ask').send({ prompt: 'edit things' }).expect(200);
    await world.runner.drain();

    expect(fs.readFileSync(path.join(outOfList, 'index.ts'), 'utf8')).toBe('ORIGINAL');
  });
});

describe('feedback history', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: true, repoRoot: repo.root });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  function seed(kind: string, planApplied = false) {
    return world.ctx.db
      .insert(feedback)
      .values({
        kind,
        inputMd: `${kind} entry`,
        responseMd: 'analyzed',
        planChangeJson: planApplied ? JSON.stringify({ description: 'gate → hybrid', applied: true }) : null,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }

  it('deletes one entry', async () => {
    const row = seed('idea');
    await request(app).delete(`/api/feedback/${row.id}`).expect(200);
    expect(world.ctx.db.select().from(feedback).all().length).toBe(0);
    await request(app).delete(`/api/feedback/${row.id}`).expect(404);
  });

  it('clears all, or just one kind', async () => {
    seed('idea');
    seed('retro');
    seed('retro');
    const byKind = await request(app).delete('/api/feedback?kind=retro').expect(200);
    expect(byKind.body.deleted).toBe(2);
    expect(world.ctx.db.select().from(feedback).all().length).toBe(1);

    const all = await request(app).delete('/api/feedback').expect(200);
    expect(all.body.deleted).toBe(1);
    expect(world.ctx.db.select().from(feedback).all().length).toBe(0);

    await request(app).delete('/api/feedback?kind=nonsense').expect(400);
  });

  it('deleting an entry whose plan change was applied never reverts the setting', async () => {
    world.ctx.settings.patch({ gateMode: 'hybrid' });
    const row = seed('idea', true);
    await request(app).delete(`/api/feedback/${row.id}`).expect(200);
    expect(world.ctx.settings.get().gateMode).toBe('hybrid');
  });
});
