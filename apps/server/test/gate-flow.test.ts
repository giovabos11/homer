// End-to-end gate flow (FR-6→FR-9, D1): score (MockRunner) → tailor (MockRunner
// drafter/reviewer + FakeRenderer) → review gate → user approval → apply via the
// REAL PlaywrightApplyDriver against the LOCAL fixture form (file://) → applied.
// No real employer is ever touched; no real claude call is ever made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { applications, followups, jobs, scheduleEvents } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { PlaywrightApplyDriver } from '../src/apply/playwright-driver';
import { ChromeApplyDriver } from '../src/apply/chrome-driver';
import { FakeRenderer } from './fake-renderer';
import { makeApp, makeFakeRepo, makeWorld } from './helpers';

const fixtureUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'greenhouse.html')).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ajs-gateflow-'));

const scoreJson = {
  technical: 85, experience: 80, behavioral: 90, career: 88,
  locationVeto: false,
  legitimacy: { verdict: 'legit', reasons: ['Company verified via independent search (mocked)'] },
};

const draftJson = {
  resume: {
    summary: 'Full-stack developer building production TypeScript, React, and Node.js applications.',
    skills: [{ category: 'Primary', items: ['TypeScript', 'React', 'Node.js'] }],
    experience: [
      {
        company: 'Rigaly', role: 'Founder', dates: '2025–', location: 'Remote',
        bullets: [{ text: 'Shipped a production TypeScript/React platform.', relevance: 95 }],
      },
    ],
    projects: [],
    education: [{ school: 'SMU', degree: 'B.S. Computer Science', dates: '2022–2025', details: [] }],
  },
  coverLetter: {
    addressee: 'Dear Hiring Manager,',
    paragraphs: ['I am applying for the Software Engineer role.', 'At Rigaly I shipped production software.', 'I would love to contribute.'],
    closing: 'Thank you for your consideration.',
  },
  keywords: ['TypeScript', 'React'],
  flags: [],
};

const script = (o: { prompt: string }) => {
  if (o.prompt.includes('fit-evaluation engine')) return { text: JSON.stringify(scoreJson) };
  if (o.prompt.includes('DRAFTER')) return { text: JSON.stringify(draftJson) };
  if (o.prompt.includes('REVIEWER')) return { text: JSON.stringify({ approved: true, critique: 'ok' }) };
  return { text: 'ok' };
};

const repo = makeFakeRepo();
const world = makeWorld({
  simulate: false,
  repoRoot: repo.root,
  script,
  renderer: new FakeRenderer(6000),
  applyDriverFactory: (name) =>
    name === 'chrome'
      ? new ChromeApplyDriver()
      : new PlaywrightApplyDriver({ profileDir: path.join(tmp, 'browser-profile'), headless: true }),
});
const app = makeApp(world);

afterAll(() => {
  world.cleanup();
  repo.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('discovered → screened → tailoring → ready_for_review → approve → applied (fixture form)', () => {
  it('runs the whole pipeline through the review gate against the local fixture form', async () => {
    // 1) Discovered job whose apply URL is the LOCAL fixture form.
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: 'gate-1',
      canonicalUrl: fixtureUrl,
      company: 'Fixture Co',
      title: 'Software Engineer',
      location: 'Dallas, TX',
      remoteType: 'hybrid',
      descriptionMd: 'Fixture Co is hiring a Software Engineer. TypeScript, React, Node.js. '.repeat(3),
    });

    // 2) Score (MockRunner rubric reply, weighted in code: 30/25/15/30).
    world.ctx.queue.enqueue('score', { payload: { jobId: job.id } });
    await world.runner.drain();
    let row = world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(row.status).toBe('screened');
    expect(row.fitScore).toBe(Math.round(85 * 0.3 + 80 * 0.25 + 90 * 0.15 + 88 * 0.3));
    expect(row.legitVerdict).toBe('legit');

    // 3) Enter the apply pipeline → tailor → ready_for_review (review gate holds).
    const applyRes = await request(app).post(`/api/jobs/${job.id}/apply`).expect(200);
    expect(applyRes.body.taskId).toBeGreaterThan(0);
    await world.runner.drain();
    const appRow = world.ctx.db.select().from(applications).where(eq(applications.jobId, job.id)).get()!;
    expect(appRow.status).toBe('ready_for_review');
    expect(appRow.approvedAt).toBeNull();

    // 4) User approves at the gate → apply worker drives the fixture form.
    await request(app).post(`/api/applications/${appRow.id}/approve`).expect(200);
    await world.runner.drain();

    const done = world.ctx.db.select().from(applications).where(eq(applications.id, appRow.id)).get()!;
    expect(done.status).toBe('applied');
    expect(done.submittedAt).not.toBeNull();
    row = world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(row.status).toBe('applied');

    // Audit trail: approval + submission with confirmation + screenshots on disk.
    const audit = JSON.parse(done.auditJson) as { action: string; confirmation?: string; screenshots?: { path: string }[] }[];
    expect(audit.some((a) => a.action === 'gate.user_approved')).toBe(true);
    const submitted = audit.find((a) => a.action === 'apply.submitted')!;
    expect(submitted.confirmation).toContain('Thank you for applying');
    expect((submitted.screenshots ?? []).length).toBeGreaterThanOrEqual(3);
    for (const s of submitted.screenshots ?? []) expect(fs.existsSync(s.path)).toBe(true);

    // Follow-up scheduled at T+followupAfterDays (FR-10/FR-12).
    expect(world.ctx.db.select().from(followups).where(eq(followups.applicationId, done.id)).all().length).toBe(1);
    expect(
      world.ctx.db.select().from(scheduleEvents).where(eq(scheduleEvents.applicationId, done.id)).all()
        .some((e) => e.type === 'followup_due'),
    ).toBe(true);
  }, 120000);

  it('apply without an approval record is refused (gate integrity)', async () => {
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: 'gate-2',
      canonicalUrl: fixtureUrl,
      company: 'Other Co',
      title: 'Platform Engineer',
      location: null,
      remoteType: 'remote',
      descriptionMd: 'desc',
    });
    const now = new Date().toISOString();
    const appRow = world.ctx.db
      .insert(applications)
      .values({ jobId: job.id, status: 'ready_for_review', gate: 'review', createdAt: now, updatedAt: now })
      .returning()
      .get();
    const task = world.ctx.queue.enqueue('apply', { payload: { applicationId: appRow.id } });
    await world.runner.drain();
    const after = world.ctx.queue.get(task.id)!;
    expect(['pending', 'failed']).toContain(after.state); // failed → retrying; never applied
    expect(after.lastError).toContain('no approval record');
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, appRow.id)).get()!.status).toBe('ready_for_review');
  });
});
