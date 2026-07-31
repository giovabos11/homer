// Granular per-task model routing: each worker reads its own settings key
// (modelScore / modelTailor / modelPrep / modelEmail / modelFollowup /
// modelFeedback), and the deprecated modelPipeline row migrates once at seed.
// MockRunner only. (Score-worker routing is covered in dashboard-round.)
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applications, emails, scheduleEvents, settingsTable } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { PIPELINE_MODEL_KEYS } from '../src/settings';
import { FakeRenderer } from './fake-renderer';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const draftJson = {
  resume: {
    summary: 'Full-stack developer building production TypeScript applications.',
    skills: [{ category: 'Primary', items: ['TypeScript', 'React'] }],
    experience: [
      {
        company: 'Rigaly', role: 'Founder', dates: '2025–', location: 'Remote',
        bullets: [{ text: 'Built a production loyalty platform with TypeScript.', relevance: 95 }],
      },
    ],
    projects: [],
    education: [{ school: 'SMU', degree: 'B.S. Computer Science', dates: '2022–2025', details: [] }],
  },
  coverLetter: {
    addressee: 'Dear Hiring Manager,',
    paragraphs: ['I am writing to apply.', 'At Rigaly I shipped production software.', 'I would welcome a conversation.'],
    closing: 'Thank you for your consideration.',
  },
  keywords: ['TypeScript'],
  flags: [],
};

const script = (o: { prompt: string }) => {
  if (o.prompt.includes('DRAFTER')) return { text: JSON.stringify(draftJson) };
  if (o.prompt.includes('REVIEWER')) return { text: JSON.stringify({ approved: true, critique: 'fine' }) };
  return { text: 'ok' };
};

describe('modelPipeline → granular keys migration', () => {
  let world: TestWorld;
  afterEach(() => world?.cleanup());

  it('fresh installs get the recommended per-task defaults (no modelPipeline key)', async () => {
    world = makeWorld();
    const res = await request(makeApp(world)).get('/api/settings').expect(200);
    expect(res.body.modelScore).toBe('haiku');
    expect(res.body.modelTailor).toBe('sonnet');
    expect(res.body.modelPrep).toBe('sonnet');
    expect(res.body.modelEmail).toBe('haiku');
    expect(res.body.modelFollowup).toBe('sonnet');
    expect(res.body.modelFeedback).toBe('sonnet');
    expect(res.body.modelScraper).toBe('haiku');
    expect(res.body.queueConcurrency).toBe(2);
    expect(res.body).not.toHaveProperty('modelPipeline');
  });

  it('a legacy modelPipeline row seeds all six granular keys once, then is deleted', () => {
    world = makeWorld();
    // Simulate an old install: the six new keys are absent, modelPipeline exists.
    for (const key of PIPELINE_MODEL_KEYS) {
      world.ctx.db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
    }
    world.ctx.db.insert(settingsTable).values({ key: 'modelPipeline', value: JSON.stringify('opus') }).run();

    world.ctx.settings.seed();

    const s = world.ctx.settings.get();
    for (const key of PIPELINE_MODEL_KEYS) expect(s[key]).toBe('opus'); // choice preserved
    const legacy = world.ctx.db.select().from(settingsTable).where(eq(settingsTable.key, 'modelPipeline')).get();
    expect(legacy).toBeUndefined(); // row deleted — migration runs once

    // Re-seeding after the migration changes nothing.
    world.ctx.settings.seed();
    for (const key of PIPELINE_MODEL_KEYS) expect(world.ctx.settings.get()[key]).toBe('opus');
  });

  it('an explicitly-set granular key survives the migration (existing values win)', () => {
    world = makeWorld();
    for (const key of PIPELINE_MODEL_KEYS) {
      world.ctx.db.delete(settingsTable).where(eq(settingsTable.key, key)).run();
    }
    // The user already picked a granular value (e.g. via an early PATCH).
    world.ctx.db.insert(settingsTable).values({ key: 'modelTailor', value: JSON.stringify('haiku') }).run();
    world.ctx.db.insert(settingsTable).values({ key: 'modelPipeline', value: JSON.stringify('opus') }).run();

    world.ctx.settings.seed();
    const s = world.ctx.settings.get();
    expect(s.modelTailor).toBe('haiku'); // explicit choice kept
    expect(s.modelScore).toBe('opus');   // the rest seeded from the legacy value
  });
});

describe('per-worker model wiring', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;
  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  it('tailor drafter AND reviewer run on modelTailor', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, renderer: new FakeRenderer(6000), script });
    world.ctx.settings.patch({ modelTailor: 'opus' });
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'mw-1', canonicalUrl: 'https://x.example/mw-1',
      company: 'WireCo', title: 'Engineer', location: 'Dallas, TX', remoteType: 'remote',
      descriptionMd: 'TypeScript role.', status: 'screened',
    });
    world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });
    await world.runner.drain();

    const drafter = world.mockAgent.calls.find((c) => c.prompt.includes('DRAFTER'))!;
    const reviewer = world.mockAgent.calls.find((c) => c.prompt.includes('REVIEWER'))!;
    expect(drafter.model).toBe('opus');
    expect(reviewer.model).toBe('opus');
  });

  it('prep_guide runs on modelPrep', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script });
    world.ctx.settings.patch({ modelPrep: 'opus' });
    const event = world.ctx.db
      .insert(scheduleEvents)
      .values({ type: 'interview', title: 'Interview — WireCo', startsAt: new Date().toISOString(), company: 'WireCo' })
      .returning()
      .get();
    world.ctx.queue.enqueue('prep_guide', { payload: { eventId: event.id } });
    await world.runner.drain();

    const call = world.mockAgent.calls.find((c) => c.prompt.includes('interview-prep engine'))!;
    expect(call.model).toBe('opus');
  });

  it('email_scan and email_send drafting run on modelEmail', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script });
    world.ctx.settings.patch({ modelEmail: 'opus' });

    world.ctx.queue.enqueue('email_scan', { payload: { trigger: 'test' } });
    await world.runner.drain(); // parks waiting_session (no Gmail in mock) — the call still happened
    const scan = world.mockAgent.calls.find((c) => c.allowedTools?.includes('mcp__claude_ai_Gmail__*'))!;
    expect(scan.model).toBe('opus');

    const email = world.ctx.db
      .insert(emails)
      .values({
        threadKey: 't-send', direction: 'outbound', classification: 'followup',
        subject: 'Following up', bodyMd: 'Body', needsApproval: 1, approvedAt: new Date().toISOString(),
      })
      .returning()
      .get();
    world.ctx.queue.enqueue('email_send', { payload: { emailId: email.id } });
    await world.runner.drain();
    const send = world.mockAgent.calls.find((c) => c.prompt.includes('email-send step'))!;
    expect(send.model).toBe('opus');
  });

  it('followup drafting runs on modelFollowup', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script });
    world.ctx.settings.patch({ modelFollowup: 'opus' });
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'mw-2', canonicalUrl: 'https://x.example/mw-2',
      company: 'Quiet Co', title: 'Engineer', location: null, remoteType: 'remote',
      descriptionMd: 'desc', status: 'applied',
    });
    const submitted = new Date(Date.now() - 15 * 86400000).toISOString();
    world.ctx.db
      .insert(applications)
      .values({ jobId: job.id, status: 'applied', gate: 'review', submittedAt: submitted, approvedAt: submitted, createdAt: submitted, updatedAt: submitted })
      .run();
    world.ctx.queue.enqueue('followup', { payload: {} });
    await world.runner.drain();

    const call = world.mockAgent.calls.find((c) => c.prompt.includes('follow-up'))!;
    expect(call.model).toBe('opus');
  });

  it('feedback runs on modelFeedback', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script });
    world.ctx.settings.patch({ modelFeedback: 'opus' });
    await request(makeApp(world)).post('/api/feedback').send({ kind: 'comment', text: 'test note' }).expect(201);
    await world.runner.drain();

    expect(world.mockAgent.calls.length).toBeGreaterThan(0);
    expect(world.mockAgent.calls.at(-1)!.model).toBe('opus');
  });
});
