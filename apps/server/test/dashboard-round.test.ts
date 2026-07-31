// "Everything through the dashboard" round: per-task model routing, the
// profile-setup chat routes, conversational ask + clear, run-discovery /
// regenerate-queries triggers, profile contact overrides + file editor
// safe-list, and the gmail probe. MockRunner only — no real agent calls.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SseEvent } from '@shared/types';
import { upsertJob } from '../src/sources/dedupe';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const scoreJson = {
  technical: 90, experience: 85, behavioral: 88, career: 84,
  locationVeto: false,
  legitimacy: { verdict: 'legit', reasons: ['verified (mock)'] },
};

const script = (o: { prompt: string }) => {
  if (o.prompt.includes('fit-evaluation engine')) return { text: JSON.stringify(scoreJson) };
  if (o.prompt.includes('mcp__claude_ai_Gmail__')) return { text: JSON.stringify({ available: true, toolCount: 16 }) };
  return { text: 'ok — mock reply' };
};

describe('dashboard round: models, setup chat, ask continuity, triggers', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  it('ask runs on modelAsk (haiku default), resumes its session, and /ask/clear resets it', async () => {
    await request(app).post('/api/ask').send({ prompt: 'hello' }).expect(200);
    await world.runner.drain();
    expect(world.mockAgent.calls.length).toBe(1);
    expect(world.mockAgent.calls[0]!.model).toBe('haiku');
    expect(world.mockAgent.calls[0]!.sessionId).toBeUndefined();

    const stored = world.ctx.settings.getInternal<string | null>('askSessionId', null);
    expect(stored).toBeTruthy();

    // Second ask resumes the stored session (conversational).
    await request(app).post('/api/ask').send({ prompt: 'and then?' }).expect(200);
    await world.runner.drain();
    expect(world.mockAgent.calls[1]!.sessionId).toBe(stored);

    // Clear → next ask starts fresh.
    const cleared = await request(app).post('/api/ask/clear').expect(200);
    expect(cleared.body.ok).toBe(true);
    expect(world.ctx.settings.getInternal<string | null>('askSessionId', null)).toBeNull();
    await request(app).post('/api/ask').send({ prompt: 'fresh start' }).expect(200);
    await world.runner.drain();
    expect(world.mockAgent.calls[2]!.sessionId).toBeUndefined();
  });

  it('model settings PATCH re-routes call sites (ask → opus, score → default)', async () => {
    await request(app).patch('/api/settings').send({ modelAsk: 'opus', modelScore: 'default' }).expect(200);

    await request(app).post('/api/ask').send({ prompt: 'which model?' }).expect(200);
    await world.runner.drain();
    expect(world.mockAgent.calls.at(-1)!.model).toBe('opus');

    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'm-1', canonicalUrl: 'https://x.example/1',
      company: 'ModelCo', title: 'Engineer', location: 'Dallas, TX', remoteType: 'remote',
      descriptionMd: 'A real description so no enrichment is attempted.',
    });
    world.ctx.queue.enqueue('score', { payload: { jobId: job.id } });
    await world.runner.tick();
    const scoreCall = world.mockAgent.calls.find((c) => c.prompt.includes('fit-evaluation engine'))!;
    expect(scoreCall.model).toBe('default');

    // Invalid model value is rejected — and so is the removed legacy key.
    await request(app).patch('/api/settings').send({ modelAsk: 'gpt-4' }).expect(400);
    await request(app).patch('/api/settings').send({ modelPipeline: 'sonnet' }).expect(400);
  });

  it('setup start → message → clear: session persists, prompts stay hygienic, deltas stream', async () => {
    const events: SseEvent[] = [];
    const off = world.ctx.bus.subscribe((e) => events.push(e));

    const start = await request(app).post('/api/setup/start').send({ mode: 'interview' }).expect(200);
    expect(typeof start.body.requestId).toBe('string');
    await world.runner.drain();

    const startCall = world.mockAgent.calls[0]!;
    expect(startCall.model).toBe('sonnet'); // modelSetup default
    expect(startCall.sessionId).toBeUndefined();
    expect(startCall.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write']); // no WebFetch
    expect(startCall.prompt).toContain('PATH C'); // interview mode
    expect(startCall.prompt).toContain('ONLY these files');
    expect(startCall.prompt).toContain('01-candidate-profile.md');
    expect(startCall.prompt).toContain('03-writing-style.md');

    const sessionId = world.ctx.settings.getInternal<string | null>('setupSessionId', null);
    expect(sessionId).toBeTruthy();

    const status = await request(app).get('/api/setup/status').expect(200);
    expect(status.body).toEqual({ active: true, mode: 'interview' });

    // setup.delta streamed and terminated with done:true.
    const deltas = events.filter((e): e is Extract<SseEvent, { type: 'setup.delta' }> => e.type === 'setup.delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.at(-1)!.done).toBe(true);
    expect(deltas[0]!.requestId).toBe(start.body.requestId);

    // message resumes the stored session with the raw user text.
    await request(app).post('/api/setup/message').send({ text: 'My name is Test Candidate' }).expect(200);
    await world.runner.drain();
    const msgCall = world.mockAgent.calls[1]!;
    expect(msgCall.sessionId).toBe(sessionId);
    expect(msgCall.prompt).toBe('My name is Test Candidate');

    // documents mode embeds Path A semantics.
    await request(app).post('/api/setup/clear').expect(200);
    await request(app).post('/api/setup/start').send({ mode: 'documents' }).expect(200);
    await world.runner.drain();
    expect(world.mockAgent.calls.at(-1)!.prompt).toContain('PATH A');

    // clear drops the session; message without one → 409.
    await request(app).post('/api/setup/clear').expect(200);
    expect(world.ctx.settings.getInternal<string | null>('setupSessionId', null)).toBeNull();
    expect((await request(app).get('/api/setup/status').expect(200)).body.active).toBe(false);
    await request(app).post('/api/setup/message').send({ text: 'hello?' }).expect(409);

    off();
  });

  it('POST /api/queue/run-discovery is deduped while a discover task is active', async () => {
    const first = await request(app).post('/api/queue/run-discovery').expect(200);
    const second = await request(app).post('/api/queue/run-discovery').expect(200);
    expect(second.body.taskId).toBe(first.body.taskId);
    const discoverTasks = world.ctx.queue.list().filter((t) => t.type === 'discover');
    expect(discoverTasks.length).toBe(1);
  });

  it('POST /api/profile/regenerate-queries queues a modelScraper run over search-queries.md', async () => {
    const res = await request(app).post('/api/profile/regenerate-queries').expect(200);
    expect(typeof res.body.requestId).toBe('string');
    // Deduped while pending.
    await request(app).post('/api/profile/regenerate-queries').expect(200);
    expect(world.ctx.queue.list().filter((t) => t.type === 'regen_queries').length).toBe(1);

    await world.runner.drain();
    const call = world.mockAgent.calls.find((c) => c.prompt.includes('search-queries.md'))!;
    expect(call).toBeTruthy();
    expect(call.model).toBe('haiku'); // modelScraper default
    expect(call.prompt).toContain('ONLY that file');
  });

  it('gmail probe: agent reports tools → connection flips ok and result is returned', async () => {
    const res = await request(app).post('/api/connections/gmail/probe').expect(200);
    expect(res.body.available).toBe(true);
    expect(res.body.toolCount).toBe(16);
    expect(res.body.connection.name).toBe('gmail');
    expect(res.body.connection.status).toBe('ok');
    const probeCall = world.mockAgent.calls.find((c) => c.prompt.includes('mcp__claude_ai_Gmail__'))!;
    expect(probeCall.model).toBe('haiku');
  });
});

describe('dashboard round: profile contact overrides + file editor safe-list', () => {
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

  it('PATCH /api/profile stores overrides that win over extracted values', async () => {
    const before = await request(app).get('/api/profile').expect(200);
    expect(before.body.fullName).toBe('Test Candidate');

    const patched = await request(app)
      .patch('/api/profile')
      .send({ name: 'Override Name', email: 'override@example.com' })
      .expect(200);
    expect(patched.body.fullName).toBe('Override Name');
    expect(patched.body.email).toBe('override@example.com');
    // Phone untouched → still extracted from CLAUDE.md.
    expect(patched.body.phone).toContain('555');

    const after = await request(app).get('/api/profile').expect(200);
    expect(after.body.fullName).toBe('Override Name');

    await request(app).patch('/api/profile').send({ email: 'not-an-email' }).expect(400);
    await request(app).patch('/api/profile').send({ phone: 'abc' }).expect(400);
    await request(app).patch('/api/profile').send({ nonsense: true }).expect(400);
  });

  it('profile file editor: GET/PUT within the safe-list only', async () => {
    // Read an allowed file.
    const claude = await request(app).get('/api/profile/files?path=CLAUDE.md').expect(200);
    expect(claude.body.content).toContain('Test Candidate');

    // Write a documents/ markdown file (dirs created as needed).
    await request(app)
      .put('/api/profile/files')
      .send({ path: 'documents/cv/notes.md', content: '# Notes\n\nhello' })
      .expect(200);
    const read = await request(app).get('/api/profile/files?path=documents/cv/notes.md').expect(200);
    expect(read.body.content).toBe('# Notes\n\nhello');

    // Skill files are editable.
    await request(app)
      .put('/api/profile/files')
      .send({ path: '.claude/skills/job-application-assistant/01-candidate-profile.md', content: '# Candidate Profile\n\nUpdated.' })
      .expect(200);

    // Everything else is rejected.
    await request(app).get('/api/profile/files?path=../secrets.md').expect(400);
    await request(app).get('/api/profile/files?path=/etc/passwd').expect(400);
    await request(app).get('/api/profile/files?path=C:\\windows\\win.ini').expect(400);
    await request(app).put('/api/profile/files').send({ path: 'documents/cv/evil.exe', content: 'x' }).expect(400);
    await request(app).put('/api/profile/files').send({ path: '.claude/skills/job-scraper/search-queries.md', content: 'x' }).expect(400);
    await request(app).put('/api/profile/files').send({ path: 'apps/server/src/index.ts', content: 'x' }).expect(400);
    await request(app).get('/api/profile/files?path=documents/cv/missing.md').expect(404);
  });

  it('saving a profile file recomputes profileReady on the next GET', async () => {
    expect((await request(app).get('/api/profile').expect(200)).body.profileReady).toBe(true);

    await request(app)
      .put('/api/profile/files')
      .send({ path: 'CLAUDE.md', content: '# Career context\n\n- **Name:** [PLACEHOLDER_NAME]\n' })
      .expect(200);
    expect((await request(app).get('/api/profile').expect(200)).body.profileReady).toBe(false);

    await request(app)
      .put('/api/profile/files')
      .send({ path: 'CLAUDE.md', content: '# Career context\n\n- **Name:** Real Person\n' })
      .expect(200);
    expect((await request(app).get('/api/profile').expect(200)).body.profileReady).toBe(true);
  });
});
