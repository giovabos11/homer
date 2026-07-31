// Approving must never produce two apply tasks for one application.
//
// The live bug: every "Approve & submit" click enqueued another apply task with
// no dedupe. With the queue paused they stacked (application 12 had three) and
// resuming would have driven the same employer form once per task — an extra
// submission nobody can retract. These cover the three layers of the fix:
// enqueue-time dedupe, the endpoint, the worker's own last-line guard, and the
// repair sweep that heals rows created before any of it existed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, inArray } from 'drizzle-orm';
import { applications, jobs, taskQueue } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { collapseDuplicateApplyTasks, isQueryShapedTitle, skipQueryShapedJobs } from '../src/queue/recovery';
import { SUPERSEDED_MARKER } from '../src/queue/queue';
import { makeApp, makeWorld, type TestWorld } from './helpers';

function seedReadyApplication(world: TestWorld, externalId: string) {
  const { job } = upsertJob(world.ctx.db, {
    source: 'freehire',
    externalId,
    canonicalUrl: `https://example.test/${externalId}`,
    company: 'Fixture Co',
    title: 'Software Engineer',
    location: 'Dallas, TX',
    remoteType: 'hybrid',
    descriptionMd: 'desc',
  });
  world.ctx.db.update(jobs).set({ status: 'ready_for_review' }).where(eq(jobs.id, job.id)).run();
  const now = new Date().toISOString();
  const app = world.ctx.db
    .insert(applications)
    .values({
      jobId: job.id,
      status: 'ready_for_review',
      gate: 'review',
      answersJson: JSON.stringify({ 'Are you authorized to work in the US?': 'Yes, for any employer' }),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return { job, app };
}

const liveApplyTasks = (world: TestWorld, applicationId: number) =>
  world.ctx.db
    .select()
    .from(taskQueue)
    .where(and(eq(taskQueue.type, 'apply'), inArray(taskQueue.state, ['pending', 'running'])))
    .all()
    .filter((t) => (JSON.parse(t.payloadJson) as { applicationId?: number }).applicationId === applicationId);

describe('approve is idempotent', () => {
  let world: TestWorld;
  let api: ReturnType<typeof makeApp>;

  beforeEach(() => {
    world = makeWorld();
    api = makeApp(world);
  });
  afterEach(() => world.cleanup());

  it('returns the SAME apply task on a second approve and inserts no duplicate row', async () => {
    const { app } = seedReadyApplication(world, 'approve-1');

    const first = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    expect(first.body.alreadyQueued).toBe(false);
    expect(first.body.taskId).toBeGreaterThan(0);

    const second = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    expect(second.body.taskId).toBe(first.body.taskId);
    expect(second.body.alreadyQueued).toBe(true);

    const third = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    expect(third.body.taskId).toBe(first.body.taskId);

    expect(liveApplyTasks(world, app.id)).toHaveLength(1);
  });

  it('carries the task state, queue position and paused flag the card needs', async () => {
    const { app } = seedReadyApplication(world, 'approve-2');
    world.ctx.queue.setPaused(true);

    const res = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    expect(res.body.taskState).toBe('pending');
    expect(res.body.queuePaused).toBe(true);
    expect(typeof res.body.queuePosition).toBe('number');
    expect(res.body.application.approvedAt).not.toBeNull();
    expect(res.body.application.id).toBe(app.id);
  });

  it('keeps the original approval timestamp and audit line on a replay', async () => {
    const { app } = seedReadyApplication(world, 'approve-3');
    const first = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    expect(second.body.application.approvedAt).toBe(first.body.application.approvedAt);

    const row = world.ctx.db.select().from(applications).where(eq(applications.id, app.id)).get()!;
    const audit = JSON.parse(row.auditJson) as { action: string }[];
    expect(audit.filter((a) => a.action === 'gate.user_approved')).toHaveLength(1);
  });

  it('enqueues a fresh task once the previous one is no longer live (retry path)', async () => {
    const { app } = seedReadyApplication(world, 'approve-4');
    const first = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    world.ctx.queue.cancel(first.body.taskId);

    const second = await request(api).post(`/api/applications/${app.id}/approve`).expect(200);
    expect(second.body.taskId).not.toBe(first.body.taskId);
    expect(second.body.alreadyQueued).toBe(false);
    expect(liveApplyTasks(world, app.id)).toHaveLength(1);
  });

  it('refuses to approve an application that was already submitted', async () => {
    const { app } = seedReadyApplication(world, 'approve-5');
    world.ctx.db
      .update(applications)
      .set({ submittedAt: new Date().toISOString() })
      .where(eq(applications.id, app.id))
      .run();
    const res = await request(api).post(`/api/applications/${app.id}/approve`).expect(409);
    expect(res.body.error).toBe('already_submitted');
    expect(liveApplyTasks(world, app.id)).toHaveLength(0);
  });
});

describe('enqueueUnique', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => world.cleanup());

  it('collapses onto the live task and merges the key into the payload', () => {
    const a = world.ctx.queue.enqueueUnique('apply', { applicationId: 7 }, { priority: 10 });
    const b = world.ctx.queue.enqueueUnique('apply', { applicationId: 7 }, { priority: 10 });
    expect(b.existing).toBe(true);
    expect(b.task.id).toBe(a.task.id);
    expect(JSON.parse(a.task.payloadJson)).toEqual({ applicationId: 7 });
    // A different application is a different key — never collapsed.
    expect(world.ctx.queue.enqueueUnique('apply', { applicationId: 8 }).task.id).not.toBe(a.task.id);
  });

  it('treats a parked task as live and a finished one as gone', () => {
    const a = world.ctx.queue.enqueueUnique('apply', { applicationId: 9 });
    world.ctx.queue.needsHuman(a.task.id, 'captcha');
    expect(world.ctx.queue.enqueueUnique('apply', { applicationId: 9 }).task.id).toBe(a.task.id);

    world.ctx.queue.complete(a.task.id);
    expect(world.ctx.queue.enqueueUnique('apply', { applicationId: 9 }).task.id).not.toBe(a.task.id);
  });
});

describe('apply worker no-ops when the application was already submitted', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld({ simulate: true });
  });
  afterEach(() => world.cleanup());

  it('completes without touching submittedAt or the status', async () => {
    const { app } = seedReadyApplication(world, 'worker-1');
    const submittedAt = '2026-07-01T10:00:00.000Z';
    world.ctx.db
      .update(applications)
      .set({ status: 'applied', approvedAt: submittedAt, submittedAt })
      .where(eq(applications.id, app.id))
      .run();

    const task = world.ctx.queue.enqueue('apply', { payload: { applicationId: app.id } });
    await world.runner.drain();

    expect(world.ctx.queue.get(task.id)!.state).toBe('done');
    const row = world.ctx.db.select().from(applications).where(eq(applications.id, app.id)).get()!;
    expect(row.submittedAt).toBe(submittedAt); // never re-stamped → never re-submitted
    const audit = JSON.parse(row.auditJson) as { action: string }[];
    expect(audit.some((a) => a.action === 'apply.skipped_already_submitted')).toBe(true);
    expect(audit.some((a) => a.action === 'apply.submitted')).toBe(false);
  });
});

describe('duplicate-collapse repair sweep', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => world.cleanup());

  it('keeps the lowest id and supersedes the rest, per application', () => {
    // Pre-dedupe rows: three stacked apply tasks for one application.
    const a1 = world.ctx.queue.enqueue('apply', { payload: { applicationId: 12 }, priority: 10 });
    const a2 = world.ctx.queue.enqueue('apply', { payload: { applicationId: 12 }, priority: 10 });
    const a3 = world.ctx.queue.enqueue('apply', { payload: { applicationId: 12 }, priority: 10 });
    const other = world.ctx.queue.enqueue('apply', { payload: { applicationId: 13 }, priority: 10 });

    expect(collapseDuplicateApplyTasks(world.ctx)).toBe(2);
    expect(world.ctx.queue.get(a1.id)!.state).toBe('pending');
    expect(world.ctx.queue.get(a2.id)!.state).toBe('done');
    expect(world.ctx.queue.get(a2.id)!.lastError).toContain(SUPERSEDED_MARKER);
    expect(world.ctx.queue.get(a3.id)!.state).toBe('done');
    expect(world.ctx.queue.get(other.id)!.state).toBe('pending'); // different application
    expect(collapseDuplicateApplyTasks(world.ctx)).toBe(0); // idempotent
  });

  it('never cancels a task already in flight', () => {
    const first = world.ctx.queue.enqueue('apply', { payload: { applicationId: 20 } });
    world.ctx.queue.enqueue('apply', { payload: { applicationId: 20 } });
    world.ctx.queue.claim(['apply']); // first is now running

    collapseDuplicateApplyTasks(world.ctx);
    expect(world.ctx.queue.get(first.id)!.state).toBe('running');
  });

  it('leaves a superseded task out of bulk retry', () => {
    world.ctx.queue.enqueue('apply', { payload: { applicationId: 30 } });
    const dup = world.ctx.queue.enqueue('apply', { payload: { applicationId: 30 } });
    collapseDuplicateApplyTasks(world.ctx);
    world.ctx.queue.retryAllFailed();
    expect(world.ctx.queue.get(dup.id)!.state).toBe('done');
  });
});

describe('query-shaped job titles', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => world.cleanup());

  it('recognizes a regex or search operator posing as a title', () => {
    expect(isQueryShapedTitle('/^Full-?stack Engineer$/i')).toBe(true);
    expect(isQueryShapedTitle('site:boards.greenhouse.io "software engineer"')).toBe(true);
    expect(isQueryShapedTitle('Software Engineer -Senior -Staff')).toBe(true);
    expect(isQueryShapedTitle('Full-stack Engineer')).toBe(false);
    expect(isQueryShapedTitle('Engineer, Platform (Remote)')).toBe(false);
    expect(isQueryShapedTitle('AI/ML Engineer')).toBe(false);
    expect(isQueryShapedTitle('Developer - Backend')).toBe(false);
  });

  it('skips those jobs with the reason recorded, and never deletes them', () => {
    const { job } = upsertJob(world.ctx.db, {
      source: 'hn_hiring',
      externalId: 'regex-1',
      canonicalUrl: 'https://example.test/regex-1',
      company: 'Better Stack',
      title: '/^Full-?stack Engineer$/i',
      location: null,
      remoteType: 'remote',
      descriptionMd: null,
    });
    const { job: real } = upsertJob(world.ctx.db, {
      source: 'hn_hiring',
      externalId: 'real-1',
      canonicalUrl: 'https://example.test/real-1',
      company: 'Better Stack',
      title: 'Full-stack Engineer',
      location: null,
      remoteType: 'remote',
      descriptionMd: null,
    });

    expect(skipQueryShapedJobs(world.ctx)).toBe(1);
    const row = world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(row.status).toBe('skipped');
    expect(JSON.parse(row.legitReasonsJson).join(' ')).toContain('search query');
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, real.id)).get()!.status).not.toBe('skipped');
    expect(skipQueryShapedJobs(world.ctx)).toBe(0); // idempotent
  });
});
