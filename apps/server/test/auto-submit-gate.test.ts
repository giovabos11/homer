// Auto-submit-when-resolved gate matrix (D1/FR-9) plus the end-to-end tailor
// behavior: resolved + review + setting on → submitted automatically with the
// full audit trail; anything unresolved parks in Ready for review.
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Settings } from '@shared/types';
import { decideGate } from '../src/pipeline/gate';
import { applications, jobs, taskQueue } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { FakeRenderer } from './fake-renderer';
import { makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const base: Settings = {
  gateMode: 'review',
  hybridThreshold: 75,
  discoveryIntervalMinutes: 360,
  emailScanIntervalMinutes: 120,
  country: 'US',
  applyDriver: 'playwright',
  perSourceGates: {},
  followupAfterDays: 10,
  maxFollowups: 2,
  modelAsk: 'haiku',
  modelSetup: 'sonnet',
  modelScraper: 'haiku',
  modelScore: 'haiku',
  modelTailor: 'sonnet',
  modelPrep: 'sonnet',
  modelEmail: 'haiku',
  modelFollowup: 'sonnet',
  modelFeedback: 'sonnet',
  autoAdvance: 'threshold',
  autoAdvanceThreshold: 70,
  queueConcurrency: 2,
  autoSubmitWhenResolved: true,
};

describe('gate matrix: autoSubmitWhenResolved', () => {
  const input = { source: 'freehire', fitScore: 80, legitVerdict: 'legit' as const };

  it('review + everything resolved + setting on → auto-submit, flagged as viaResolved', () => {
    const d = decideGate(base, { ...input, answersResolved: true });
    expect(d.autoSubmit).toBe(true);
    expect(d.viaResolved).toBe(true);
    expect(d.reason).toContain('standing answers');
  });

  it('review + an unresolved answer → review card, never a guess', () => {
    const d = decideGate(base, { ...input, answersResolved: false });
    expect(d.autoSubmit).toBe(false);
    expect(d.reason).toContain('still need you');
  });

  it('the setting off restores plain review behavior', () => {
    const d = decideGate({ ...base, autoSubmitWhenResolved: false }, { ...input, answersResolved: true });
    expect(d.autoSubmit).toBe(false);
  });

  it('LinkedIn is always review, in every mode', () => {
    const li = { source: 'linkedin', fitScore: 99, legitVerdict: 'legit' as const, answersResolved: true };
    expect(decideGate(base, li).autoSubmit).toBe(false);
    expect(decideGate({ ...base, gateMode: 'auto' }, li).autoSubmit).toBe(false);
    expect(decideGate({ ...base, gateMode: 'hybrid' }, li).autoSubmit).toBe(false);
  });

  it('hybrid keeps the score threshold on top of the resolved rule', () => {
    const hybrid = { ...base, gateMode: 'hybrid' as const };
    expect(decideGate(hybrid, { ...input, fitScore: 80, answersResolved: true }).autoSubmit).toBe(true);
    expect(decideGate(hybrid, { ...input, fitScore: 60, answersResolved: true }).autoSubmit).toBe(false);
    expect(decideGate(hybrid, { ...input, fitScore: 95, answersResolved: false }).autoSubmit).toBe(false);
  });

  it('legitimacy still outranks everything', () => {
    expect(decideGate(base, { ...input, legitVerdict: 'suspicious', answersResolved: true }).autoSubmit).toBe(false);
    expect(decideGate(base, { ...input, legitVerdict: 'scam', answersResolved: true }).autoSubmit).toBe(false);
  });

  it('answersResolved undefined keeps the pre-standing-answers behavior', () => {
    expect(decideGate(base, input).autoSubmit).toBe(false);
    expect(decideGate({ ...base, gateMode: 'auto' }, input).autoSubmit).toBe(true);
  });
});

// ---- end-to-end through the real tailor worker ----

const draftJson = {
  resume: {
    summary: 'Full-stack developer building production TypeScript, React, and Node.js applications.',
    skills: [{ category: 'Primary', items: ['TypeScript', 'React'] }],
    experience: [
      {
        company: 'Rigaly', role: 'Founder', dates: '2025–', location: 'Remote',
        bullets: [{ text: 'Shipped a production TypeScript platform.', relevance: 95 }],
      },
    ],
    projects: [],
    education: [{ school: 'SMU', degree: 'B.S. Computer Science', dates: '2022–2025', details: [] }],
  },
  coverLetter: {
    addressee: 'Dear Hiring Manager,',
    paragraphs: ['I am applying.', 'I shipped production software.', 'I would love to contribute.'],
    closing: 'Thank you for your consideration.',
  },
  keywords: ['TypeScript', 'React'],
  flags: [],
};

const script = (o: { prompt: string }) => {
  if (o.prompt.includes('DRAFTER')) return { text: JSON.stringify(draftJson) };
  if (o.prompt.includes('REVIEWER')) return { text: JSON.stringify({ approved: true, critique: 'ok' }) };
  return { text: 'ok' };
};

describe('tailor worker honors the resolved gate', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;

  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  function seed(w: TestWorld) {
    const { job } = upsertJob(w.ctx.db, {
      source: 'freehire',
      externalId: 'gate-res-1',
      canonicalUrl: 'https://example.com/jobs/res-1',
      company: 'Resolved Co',
      title: 'Software Engineer',
      location: 'Dallas, TX',
      remoteType: 'remote',
      descriptionMd: 'We need TypeScript and React. '.repeat(5),
      status: 'screened',
    });
    w.ctx.db.update(jobs).set({ fitScore: 82, legitVerdict: 'legit' }).where(eq(jobs.id, job.id)).run();
    return job;
  }

  it('every answer resolved → submitted automatically, marked, and audited', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, renderer: new FakeRenderer(6000), script });
    world.ctx.standing.patch({
      salaryExpectation: 'Open, targeting market rate for the role',
      earliestStartDate: 'Two weeks from an offer',
      citizenshipStatus: 'Authorized to work in the US for any employer',
      securityClearance: 'None',
    });
    const job = seed(world);
    world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });
    await world.runner.tick(); // tailor only — do not run the apply task

    const app = world.ctx.db.select().from(applications).where(eq(applications.jobId, job.id)).get()!;
    expect(app.approvedAt).not.toBeNull();
    expect(app.autoSubmitted).toBe(1);
    expect(fs.existsSync(app.resumePath!)).toBe(true);
    const audit = JSON.parse(app.auditJson) as { action: string; viaResolved?: boolean; answersResolved?: boolean }[];
    expect(audit.find((a) => a.action === 'gate.auto_approved')?.viaResolved).toBe(true);
    expect(audit.find((a) => a.action === 'tailor.finished')?.answersResolved).toBe(true);
    // The apply task exists, so it lands in Applied with the full trail.
    expect(world.ctx.db.select().from(taskQueue).where(eq(taskQueue.type, 'apply')).all().length).toBe(1);
  });

  it('an unanswered question keeps the review card even with the setting on', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, renderer: new FakeRenderer(6000), script });
    world.ctx.standing.patch({ salaryExpectation: 'Open, market rate' }); // start date still unset
    const job = seed(world);
    world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });
    await world.runner.tick();

    const app = world.ctx.db.select().from(applications).where(eq(applications.jobId, job.id)).get()!;
    expect(app.status).toBe('ready_for_review');
    expect(app.approvedAt).toBeNull();
    expect(app.autoSubmitted).toBe(0);
    expect(world.ctx.db.select().from(taskQueue).where(eq(taskQueue.type, 'apply')).all().length).toBe(0);
  });

  it('the setting off keeps the review card even when nothing is unknown', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, renderer: new FakeRenderer(6000), script });
    world.ctx.settings.patch({ autoSubmitWhenResolved: false });
    world.ctx.standing.patch({
      salaryExpectation: 'Open, market rate',
      earliestStartDate: 'Immediately',
      citizenshipStatus: 'Authorized for any US employer',
      securityClearance: 'None',
    });
    const job = seed(world);
    world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });
    await world.runner.tick();

    const app = world.ctx.db.select().from(applications).where(eq(applications.jobId, job.id)).get()!;
    expect(app.approvedAt).toBeNull();
    expect(app.autoSubmitted).toBe(0);
  });
});
