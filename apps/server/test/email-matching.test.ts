// Email intake: offers, and matching that refuses to guess.
//
// Two defects this covers. (1) `EmailClass` had no `offer`, so a formal offer
// classified as `reply_accepted` and moved the application to Interview — the
// Offer column could never fill from email. (2) `matchApplication` was
// `LIKE '%company%'` + `.get()`: with two applications at one employer the row
// SQLite happened to return first won, so a rejection could close the wrong
// application silently.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { applications, emails, jobs, scheduleEvents } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { processScanItems, type ScanItem } from '../src/workers/email-intake';
import { makeApp, makeWorld, type TestWorld } from './helpers';

function seedApplication(
  world: TestWorld,
  company: string,
  title: string,
  opts: { url?: string; status?: string } = {},
) {
  const { job } = upsertJob(world.ctx.db, {
    source: 'freehire',
    externalId: `${company}-${title}`,
    canonicalUrl: opts.url ?? `https://example.com/${encodeURIComponent(company)}/${encodeURIComponent(title)}`,
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
    .values({
      jobId: job.id,
      status: opts.status ?? 'applied',
      gate: 'review',
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return { job, app };
}

const item = (over: Partial<ScanItem> & Pick<ScanItem, 'threadKey' | 'classification'>): ScanItem => ({
  subject: 'Subject',
  from: 'someone@example.com',
  receivedAt: '2026-07-20T10:00:00Z',
  summary: 'Summary',
  bodyMd: 'Body',
  company: null,
  jobTitle: null,
  jobUrl: null,
  interview: null,
  offer: null,
  ...over,
});

describe('offer classification', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld({ simulate: false });
  });
  afterEach(() => world.cleanup());

  it('moves the application to offer (not interview) and records the response deadline', () => {
    const { job, app } = seedApplication(world, 'Notion', 'Software Engineer, Product');

    const summary = processScanItems(world.ctx, [
      item({
        threadKey: 'notion-offer',
        classification: 'offer',
        company: 'Notion',
        jobTitle: 'Software Engineer, Product',
        summary: 'Written offer',
        offer: { salary: '$172,000 base', startDate: '2026-09-08', respondBy: '2026-08-07T17:00:00Z' },
      }),
    ]);
    expect(summary.offersRecorded).toBe(1);
    expect(summary.applicationsUpdated).toBe(1);

    expect(world.ctx.db.select().from(applications).where(eq(applications.id, app.id)).get()!.status).toBe('offer');
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('offer');

    // The stated terms survive into the stored summary, in the employer's words.
    const row = world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'notion-offer')).get()!;
    expect(row.summary).toContain('$172,000 base');
    expect(row.summary).toContain('respond by');

    // A deadline the employer named belongs on the Schedule.
    const deadline = world.ctx.db.select().from(scheduleEvents).all().find((e) => e.type === 'deadline');
    expect(deadline).toBeDefined();
    expect(deadline!.startsAt).toBe('2026-08-07T17:00:00Z');
    expect(deadline!.applicationId).toBe(app.id);
  });

  it('leaves a merely positive reply at interview', () => {
    const { app } = seedApplication(world, 'Notion', 'Software Engineer, Product');
    processScanItems(world.ctx, [
      item({ threadKey: 'notion-positive', classification: 'reply_accepted', company: 'Notion' }),
    ]);
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, app.id)).get()!.status).toBe('interview');
  });

  it('records an offer with no deadline without inventing one', () => {
    seedApplication(world, 'Linear', 'Product Engineer');
    processScanItems(world.ctx, [
      item({ threadKey: 'linear-offer', classification: 'offer', company: 'Linear', offer: { salary: '$160k' } }),
    ]);
    expect(world.ctx.db.select().from(scheduleEvents).all().filter((e) => e.type === 'deadline')).toHaveLength(0);
  });
});

describe('application matching', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld({ simulate: false });
  });
  afterEach(() => world.cleanup());

  it('matches by posting URL ahead of company name', () => {
    seedApplication(world, 'Cloudflare', 'Systems Engineer, Edge', { url: 'https://jobs.cloudflare.com/edge' });
    const workers = seedApplication(world, 'Cloudflare', 'Software Engineer, Workers', {
      url: 'https://jobs.cloudflare.com/workers',
    });

    processScanItems(world.ctx, [
      item({
        threadKey: 'cf-url',
        classification: 'reply_rejected',
        company: 'Cloudflare',
        // Trailing slash, www and a query string are noise, not a different URL.
        jobUrl: 'https://www.jobs.cloudflare.com/workers/?src=email',
      }),
    ]);

    const row = world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'cf-url')).get()!;
    expect(row.applicationId).toBe(workers.app.id);
    expect(row.matchBasis).toBe('url');
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, workers.app.id)).get()!.status).toBe('rejected');
  });

  it('uses the job title to separate two applications at the same employer', () => {
    const edge = seedApplication(world, 'Cloudflare', 'Systems Engineer, Edge');
    const workers = seedApplication(world, 'Cloudflare', 'Software Engineer, Workers');

    processScanItems(world.ctx, [
      item({
        threadKey: 'cf-title',
        classification: 'reply_rejected',
        company: 'Cloudflare',
        jobTitle: 'Software Engineer, Workers',
      }),
    ]);

    const row = world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'cf-title')).get()!;
    expect(row.applicationId).toBe(workers.app.id);
    expect(row.matchBasis).toBe('company_title');
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, edge.app.id)).get()!.status).toBe('applied');
  });

  it('ignores case, punctuation and legal suffixes in the company name', () => {
    const { app } = seedApplication(world, 'Vector Systems, Inc.', 'Software Engineer');
    processScanItems(world.ctx, [
      item({ threadKey: 'vector', classification: 'reply_accepted', company: 'vector systems' }),
    ]);
    const row = world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'vector')).get()!;
    expect(row.applicationId).toBe(app.id);
    expect(row.matchBasis).toBe('company');
  });

  it('prefers a live application over a closed one', () => {
    seedApplication(world, 'Bluegrid', 'React Native Developer', { status: 'rejected' });
    const live = seedApplication(world, 'Bluegrid', 'Frontend Engineer', { status: 'applied' });
    processScanItems(world.ctx, [
      item({ threadKey: 'bluegrid', classification: 'interview_invite', company: 'Bluegrid' }),
    ]);
    expect(world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'bluegrid')).get()!.applicationId).toBe(live.app.id);
  });

  it('refuses to guess between two equally good candidates and offers them as choices', () => {
    const edge = seedApplication(world, 'Cloudflare', 'Systems Engineer, Edge');
    const workers = seedApplication(world, 'Cloudflare', 'Software Engineer, Workers');

    const summary = processScanItems(world.ctx, [
      item({ threadKey: 'cf-ambiguous', classification: 'reply_rejected', company: 'Cloudflare' }),
    ]);
    expect(summary.ambiguous).toBe(1);

    const row = world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'cf-ambiguous')).get()!;
    expect(row.applicationId).toBeNull();
    expect(row.matchBasis).toBeNull();
    const candidates = JSON.parse(row.matchCandidatesJson) as { applicationId: number }[];
    expect(candidates.map((c) => c.applicationId).sort()).toEqual([edge.app.id, workers.app.id].sort());

    // Crucially: neither application was touched.
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, edge.app.id)).get()!.status).toBe('applied');
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, workers.app.id)).get()!.status).toBe('applied');
  });
});

describe('PATCH /api/emails/:id — manual assignment', () => {
  let world: TestWorld;
  let api: ReturnType<typeof makeApp>;
  beforeEach(() => {
    world = makeWorld({ simulate: false });
    api = makeApp(world);
  });
  afterEach(() => world.cleanup());

  it('links an ambiguous email and applies the status update it was holding back', async () => {
    seedApplication(world, 'Cloudflare', 'Systems Engineer, Edge');
    const workers = seedApplication(world, 'Cloudflare', 'Software Engineer, Workers');
    processScanItems(world.ctx, [
      item({ threadKey: 'cf-manual', classification: 'reply_rejected', company: 'Cloudflare' }),
    ]);
    const row = world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'cf-manual')).get()!;

    const res = await request(api).patch(`/api/emails/${row.id}`).send({ applicationId: workers.app.id }).expect(200);
    expect(res.body.applicationId).toBe(workers.app.id);
    expect(res.body.matchBasis).toBe('manual');
    expect(res.body.matchCandidates).toEqual([]);
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, workers.app.id)).get()!.status).toBe('rejected');
  });

  it('unlinks with null and rejects an unknown application', async () => {
    const { app } = seedApplication(world, 'Linear', 'Product Engineer');
    processScanItems(world.ctx, [item({ threadKey: 'linear-1', classification: 'other', company: 'Linear' })]);
    const row = world.ctx.db.select().from(emails).where(eq(emails.threadKey, 'linear-1')).get()!;
    expect(row.applicationId).toBe(app.id);

    const cleared = await request(api).patch(`/api/emails/${row.id}`).send({ applicationId: null }).expect(200);
    expect(cleared.body.applicationId).toBeNull();
    expect(cleared.body.matchBasis).toBeNull();

    await request(api).patch(`/api/emails/${row.id}`).send({ applicationId: 9999 }).expect(404);
  });
});
