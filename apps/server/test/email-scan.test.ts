// Email scan classification (FR-2, D4): intake processing, the worker's
// waiting_session behavior without Gmail tools, and the /email-bridge internal
// routes that resolve parked tasks. MockRunner only.
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { applications, emails, jobs, scheduleEvents, taskQueue } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { processScanItems, type ScanItem } from '../src/workers/email-intake';
import { makeApp, makeWorld, type TestWorld } from './helpers';

function seedApplication(world: TestWorld, company: string, title: string) {
  const { job } = upsertJob(world.ctx.db, {
    source: 'freehire',
    externalId: `seed-${company}`,
    canonicalUrl: `https://example.com/${company}`,
    company,
    title,
    location: null,
    remoteType: 'remote',
    descriptionMd: 'desc',
    status: 'applied',
  });
  const now = new Date().toISOString();
  const app = world.ctx.db
    .insert(applications)
    .values({ jobId: job.id, status: 'applied', gate: 'review', submittedAt: now, createdAt: now, updatedAt: now })
    .returning()
    .get();
  return { job, app };
}

const items: ScanItem[] = [
  {
    threadKey: 't-interview',
    subject: 'Interview — Software Engineer at Vector Systems',
    from: 'recruiter@vectorsystems.com',
    receivedAt: '2026-07-20T10:00:00Z',
    classification: 'interview_invite',
    summary: 'Technical interview proposed',
    bodyMd: 'We would like to schedule a technical interview.',
    company: 'Vector Systems',
    interview: { startsAt: '2026-08-05T15:00:00Z', title: 'Technical interview — Vector Systems' },
  },
  {
    threadKey: 't-reject',
    subject: 'Your application at Bluegrid',
    from: 'no-reply@bluegrid.io',
    classification: 'reply_rejected',
    summary: 'Rejection',
    bodyMd: 'We decided to move forward with other candidates.',
    company: 'Bluegrid',
  },
  {
    threadKey: 't-opportunity',
    subject: 'Opportunity: Platform Engineer at Nimbus Labs',
    from: 'talent@nimbuslabs.dev',
    classification: 'opportunity',
    summary: 'Recruiter outreach for a new role',
    bodyMd: 'We think you would be a great Platform Engineer.',
    company: 'Nimbus Labs',
    jobTitle: 'Platform Engineer',
    jobUrl: 'https://example.com/nimbus/platform-engineer',
  },
];

describe('email intake classification', () => {
  let world: TestWorld;
  afterEach(() => world?.cleanup());

  it('classifies into status updates, new opportunity jobs, and interview events + prep tasks', () => {
    world = makeWorld({ simulate: false });
    const vector = seedApplication(world, 'Vector Systems', 'Software Engineer II');
    const bluegrid = seedApplication(world, 'Bluegrid', 'React Native Developer');

    const summary = processScanItems(world.ctx, items);
    expect(summary.inserted).toBe(3);
    expect(summary.applicationsUpdated).toBe(2);
    expect(summary.opportunitiesCreated).toBe(1);
    expect(summary.interviewsScheduled).toBe(1);

    // (a) status updates
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, vector.app.id)).get()!.status).toBe('interview');
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, bluegrid.app.id)).get()!.status).toBe('rejected');

    // (b) new opportunity job entered scoring
    const opp = world.ctx.db.select().from(jobs).where(eq(jobs.company, 'Nimbus Labs')).get()!;
    expect(opp.source).toBe('email');
    expect(opp.status).toBe('discovered');
    expect(world.ctx.db.select().from(taskQueue).where(eq(taskQueue.type, 'score')).all().length).toBeGreaterThanOrEqual(1);

    // (c) interview invite → schedule event + prep_guide task
    const event = world.ctx.db.select().from(scheduleEvents).all().find((e) => e.type === 'interview')!;
    expect(event.startsAt).toBe('2026-08-05T15:00:00Z');
    expect(event.applicationId).toBe(vector.app.id);
    expect(world.ctx.db.select().from(taskQueue).where(eq(taskQueue.type, 'prep_guide')).all().length).toBe(1);

    // Idempotent by threadKey: re-running the same batch inserts nothing.
    const again = processScanItems(world.ctx, items);
    expect(again.inserted).toBe(0);
    expect(again.skippedExisting).toBe(3);
  });

  it('worker parks as waiting_session when the agent reports no Gmail tools', async () => {
    world = makeWorld({
      simulate: false,
      script: () => ({ text: JSON.stringify({ gmailAvailable: false, emails: [] }) }),
    });
    const task = world.ctx.queue.enqueue('email_scan', { payload: { trigger: 'test' } });
    await world.runner.drain();
    expect(world.ctx.queue.get(task.id)!.state).toBe('waiting_session');
  });

  it('worker processes results when the agent has Gmail tools', async () => {
    world = makeWorld({
      simulate: false,
      script: (o) =>
        o.prompt.includes('email-scan step')
          ? { text: JSON.stringify({ gmailAvailable: true, emails: [items[2]] }) }
          : { text: 'ok' },
    });
    const task = world.ctx.queue.enqueue('email_scan', { payload: { trigger: 'test' } });
    await world.runner.drain();
    expect(world.ctx.queue.get(task.id)!.state).toBe('done');
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.company, 'Nimbus Labs')).get()).toBeTruthy();
  });

  it('the /email-bridge internal routes ingest scan results and resolve parked tasks', async () => {
    world = makeWorld({
      simulate: false,
      script: () => ({ text: JSON.stringify({ gmailAvailable: false, emails: [] }) }),
    });
    const app = makeApp(world);
    seedApplication(world, 'Vector Systems', 'Software Engineer II');

    // Park a scan task the way headless runs do.
    const task = world.ctx.queue.enqueue('email_scan', { payload: { trigger: 'schedule' } });
    await world.runner.drain();
    expect(world.ctx.queue.get(task.id)!.state).toBe('waiting_session');

    const res = await request(app)
      .post('/api/internal/email-bridge/scan-results')
      .send({ items })
      .expect(200);
    expect(res.body.inserted).toBe(3);
    expect(res.body.resolvedTasks).toContain(task.id);
    expect(world.ctx.queue.get(task.id)!.state).toBe('done');
  });

  it('the /email-bridge sent route only accepts APPROVED outbound drafts', async () => {
    world = makeWorld({ simulate: false });
    const app = makeApp(world);
    const draft = world.ctx.db
      .insert(emails)
      .values({
        threadKey: 'out-1',
        direction: 'outbound',
        classification: 'followup',
        subject: 'Following up',
        summary: 'draft',
        bodyMd: 'Hello',
        needsApproval: 1,
      })
      .returning()
      .get();

    // Unapproved → 409 (FR-11: nothing sends without a recorded approval).
    await request(app).post('/api/internal/email-bridge/sent').send({ emailId: draft.id }).expect(409);

    world.ctx.db.update(emails).set({ approvedAt: new Date().toISOString() }).where(eq(emails.id, draft.id)).run();
    const sendTask = world.ctx.queue.enqueue('email_send', { payload: { emailId: draft.id } });
    world.ctx.queue.waitingSession(sendTask.id, 'test-park');

    const ok = await request(app).post('/api/internal/email-bridge/sent').send({ emailId: draft.id }).expect(200);
    expect(ok.body.resolvedTasks).toContain(sendTask.id);
    const sent = world.ctx.db.select().from(emails).where(eq(emails.id, draft.id)).get()!;
    expect(sent.sentAt).not.toBeNull();
    expect(sent.needsApproval).toBe(0);
  });
});
