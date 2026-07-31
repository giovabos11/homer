// Apply worker: channel branching, liveness, re-resolution, park reasons.
//
// Every case here is one the live database actually produced. No network: the
// world's httpFetch is stubbed, and the apply driver is a spy that records
// whether it was reached at all — "the driver never ran" is the assertion that
// matters most for a dead posting or an aggregator link.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applications, emails, jobs } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { ApplyBlocked, type ApplyDriver, type ApplyOutcome, type ApplyRunArgs } from '../src/apply/driver';
import { makeFakeRepo, makeWorld, stubFetch, type TestWorld } from './helpers';

const MINTMCP_BOARD_API = 'https://api.ashbyhq.com/posting-api/job-board/mintmcp?includeCompensation=true';
const STALE_MINTMCP = 'https://jobs.ashbyhq.com/mintmcp/b3334a8b-521e-4989-82b1-988ff52a2671?utm_source=freehire.me';
const LIVE_MINTMCP_ID = '34d8220f-a48e-4f9a-bfc6-2079f775ef1b';

const ASHBY_BOARD = JSON.stringify({
  jobs: [
    { id: LIVE_MINTMCP_ID, title: 'Software Engineer', location: 'San Francisco, CA', isListed: true, jobUrl: `https://jobs.ashbyhq.com/mintmcp/${LIVE_MINTMCP_ID}` },
    { id: '185bd659-fd23-45d3-b505-47e940ad29da', title: 'Account Executive', location: 'San Francisco, CA', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/mintmcp/185bd659-fd23-45d3-b505-47e940ad29da' },
  ],
});

/** Records the URL it was asked to drive; submits unless told to park. */
class SpyDriver implements ApplyDriver {
  readonly name = 'playwright' as const;
  calls: string[] = [];
  constructor(private mode: 'submit' | 'park-captcha' | 'park-dead' = 'submit') {}
  async apply(args: ApplyRunArgs): Promise<ApplyOutcome> {
    this.calls.push(args.target.url);
    if (this.mode === 'park-captcha') {
      throw new ApplyBlocked('A Google reCAPTCHA is blocking the form.', [], [], 'captcha');
    }
    if (this.mode === 'park-dead') {
      throw new ApplyBlocked('The posting is no longer available (no longer accepting applications).', [], [], 'dead_posting');
    }
    return { submitted: true, ats: 'ashby', confirmationText: 'Thank you for applying', screenshots: [], filledFields: {}, answersUsed: {} };
  }
  async dispose(): Promise<void> {}
}

describe('apply worker — channels, liveness, re-resolution', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let driver: SpyDriver;

  const boot = (opts: { fetch?: Parameters<typeof makeWorld>[0]['httpFetch']; mode?: 'submit' | 'park-captcha' | 'park-dead' } = {}) => {
    repo = makeFakeRepo();
    driver = new SpyDriver(opts.mode ?? 'submit');
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      applyDriverFactory: () => driver,
      httpFetch: opts.fetch,
    });
  };

  /** An approved application, ready for the apply worker to pick up. */
  const approved = (job: { canonicalUrl: string; company: string; title: string; source?: string; externalId?: string | null; location?: string | null; descriptionMd?: string | null }) => {
    const { job: row } = upsertJob(world.ctx.db, {
      source: job.source ?? 'freehire',
      externalId: job.externalId ?? `ext-${job.company}`,
      canonicalUrl: job.canonicalUrl,
      company: job.company,
      title: job.title,
      location: job.location ?? null,
      remoteType: 'remote',
      descriptionMd: job.descriptionMd ?? 'A job.',
    });
    const now = new Date().toISOString();
    const app = world.ctx.db
      .insert(applications)
      .values({
        jobId: row.id, status: 'ready_for_review', gate: 'review', approvedAt: now,
        answersJson: '{}', resumePath: '/tmp/resume.pdf', coverLetterPath: '/tmp/cover.pdf',
        createdAt: now, updatedAt: now,
      })
      .returning()
      .get();
    const task = world.ctx.queue.enqueue('apply', { payload: { applicationId: app.id } });
    return { job: row, app, task };
  };

  const reload = (id: number) => world.ctx.db.select().from(applications).where(eq(applications.id, id)).get()!;
  const reloadJob = (id: number) => world.ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
  const auditOf = (id: number) => JSON.parse(reload(id).auditJson) as { action: string; [k: string]: unknown }[];

  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  it('application 12: a stale Ashby id is re-resolved to the live posting and applied', async () => {
    boot({ fetch: stubFetch({ [MINTMCP_BOARD_API]: ASHBY_BOARD }) });
    const { job, app, task } = approved({
      canonicalUrl: STALE_MINTMCP, company: 'mintmcp', title: 'Software Engineer', location: 'San Francisco, CA',
    });

    await world.runner.drain();

    expect(world.ctx.queue.get(task.id)!.state).toBe('done');
    expect(reload(app.id).status).toBe('applied');
    // The driver was pointed at the CURRENT posting, not the dead one.
    expect(driver.calls).toEqual([`https://jobs.ashbyhq.com/mintmcp/${LIVE_MINTMCP_ID}`]);
    const fresh = reloadJob(job.id);
    expect(fresh.canonicalUrl).toContain(LIVE_MINTMCP_ID);
    expect(fresh.externalId).toBe(`ashby:mintmcp:${LIVE_MINTMCP_ID}`);

    const audit = auditOf(app.id);
    expect(audit.find((a) => a.action === 'apply.liveness')).toMatchObject({ alive: false, reason: 'board_missing' });
    expect(audit.find((a) => a.action === 'apply.reresolve')).toMatchObject({ outcome: 'resolved' });
    const advisories = JSON.parse(reload(app.id).advisoriesJson) as { text: string }[];
    expect(advisories.some((a) => /posting id had changed/i.test(a.text))).toBe(true);
  });

  it('no confident match → expired, not a captcha, and the driver never runs', async () => {
    boot({ fetch: stubFetch({ [MINTMCP_BOARD_API]: ASHBY_BOARD }) });
    const { job, app, task } = approved({
      canonicalUrl: STALE_MINTMCP, company: 'mintmcp', title: 'Principal Kernel Engineer',
    });

    await world.runner.drain();

    const t = world.ctx.queue.get(task.id)!;
    expect(t.state).toBe('failed'); // terminal: retrying re-reads the same board
    expect(t.attempts).toBe(0);
    expect(t.lastError).toContain('Posting no longer available');
    expect(t.lastError).toContain('Account Executive'); // what IS open there
    expect(driver.calls).toEqual([]);

    expect(reloadJob(job.id).status).toBe('expired');
    expect(reload(app.id).status).toBe('expired');
    expect(reload(app.id).submittedAt).toBeNull();
    const advisories = JSON.parse(reload(app.id).advisoriesJson) as { text: string }[];
    expect(advisories.some((a) => /no longer available/i.test(a.text))).toBe(true);
  });

  it('ambiguity is asked about, never guessed', async () => {
    const twoBoard = JSON.stringify({
      jobs: [
        { id: 'aaa', title: 'Software Engineer', isListed: true },
        { id: 'bbb', title: 'Software Engineer', isListed: true },
      ],
    });
    boot({ fetch: stubFetch({ [MINTMCP_BOARD_API]: twoBoard }) });
    const { app, task } = approved({ canonicalUrl: STALE_MINTMCP, company: 'mintmcp', title: 'Software Engineer' });

    await world.runner.drain();

    expect(driver.calls).toEqual([]);
    expect(world.ctx.queue.get(task.id)!.lastError).toMatch(/nothing distinguishes them/i);
    expect(reload(app.id).status).toBe('expired');
    expect(auditOf(app.id).find((a) => a.action === 'apply.reresolve')).toMatchObject({ outcome: 'ambiguous' });
  });

  it('a whatjobs aggregator link that resolves to an ATS form is rewritten and applied', async () => {
    const start = 'https://www.whatjobs.com/pub_api__cpl__2626788452__7065?geoID=2251';
    const dest = 'https://job-boards.greenhouse.io/harnham/jobs/777';
    boot({
      fetch: stubFetch({
        [start]: { status: 301, headers: { location: dest } },
        [dest]: { status: 200, body: '<form><input name="email"><button type="submit">Apply</button></form>' },
        'https://boards-api.greenhouse.io/v1/boards/harnham/jobs': JSON.stringify({
          jobs: [{ id: 777, title: 'Software Engineer', location: { name: 'Remote' }, absolute_url: dest }],
        }),
      }),
    });
    const { job, app, task } = approved({ canonicalUrl: start, company: 'Harnham', title: 'Software Engineer' });

    await world.runner.drain();

    expect(world.ctx.queue.get(task.id)!.state).toBe('done');
    expect(driver.calls).toEqual([dest]);
    expect(reloadJob(job.id).canonicalUrl).toBe(dest);
    expect(reloadJob(job.id).applyChannel).toBe('ats_form');
    expect(reload(app.id).status).toBe('applied');
    expect(auditOf(app.id).find((a) => a.action === 'apply.redirect_followed')).toMatchObject({ resolved: true });
  });

  it('a whatjobs link that dead-ends on the aggregator becomes needs_manual (the live behaviour)', async () => {
    const start = 'https://www.whatjobs.com/pub_api__cpl__2626788452__7065?geoID=2251';
    const home = 'https://www.whatjobs.com/';
    boot({
      fetch: stubFetch({
        [start]: { status: 301, headers: { location: home } },
        [home]: { status: 200, body: '<html><body>Search jobs</body></html>' },
      }),
    });
    const { job, app, task } = approved({ canonicalUrl: start, company: 'Harnham', title: 'Software Engineer' });

    await world.runner.drain();

    const t = world.ctx.queue.get(task.id)!;
    expect(t.state).toBe('failed');
    expect(t.lastError).toMatch(/aggregator redirect, not an employer application form/i);
    expect(driver.calls).toEqual([]);
    expect(reloadJob(job.id).status).toBe('needs_manual');
    expect(reload(app.id).status).toBe('needs_manual');
    const advisories = JSON.parse(reload(app.id).advisoriesJson) as { text: string }[];
    expect(advisories.some((a) => /dead-ends on the aggregator/i.test(a.text))).toBe(true);
  });

  it('an HN posting drafts an approval-gated Outbox email instead of driving a browser', async () => {
    boot();
    const { app, task } = approved({
      source: 'hn_hiring',
      canonicalUrl: 'https://news.ycombinator.com/item?id=48756811',
      company: 'OneChronos',
      title: 'Full-stack Engineer',
      descriptionMd: 'OneChronos | Full-stack Engineer | NYC. Email careers@onechronos.com with a resume.',
    });

    await world.runner.drain();

    expect(world.ctx.queue.get(task.id)!.state).toBe('done');
    expect(driver.calls).toEqual([]);
    // Nothing was submitted — the Outbox approval is the gate now.
    expect(reload(app.id).submittedAt).toBeNull();

    const draft = world.ctx.db.select().from(emails).where(eq(emails.applicationId, app.id)).get()!;
    expect(draft.direction).toBe('outbound');
    expect(draft.needsApproval).toBe(1);
    expect(draft.approvedAt).toBeNull();
    expect(draft.sentAt).toBeNull();
    expect(draft.bodyMd).toContain('careers@onechronos.com');
    expect(draft.bodyMd).toContain('/tmp/resume.pdf'); // the tailored PDFs, named
    expect(auditOf(app.id).find((a) => a.action === 'apply.email_drafted')).toMatchObject({ to: 'careers@onechronos.com' });
  });

  it('the email draft is created once, not once per retry', async () => {
    boot();
    const { app } = approved({
      source: 'hn_hiring',
      canonicalUrl: 'https://news.ycombinator.com/item?id=1',
      company: 'Rabbet',
      title: 'Engineer',
      descriptionMd: 'Email kjackson@rabbet.com',
    });
    await world.runner.drain();
    world.ctx.queue.enqueue('apply', { payload: { applicationId: app.id } });
    await world.runner.drain();

    expect(world.ctx.db.select().from(emails).where(eq(emails.applicationId, app.id)).all()).toHaveLength(1);
  });

  it('an email posting with no address falls back to needs_manual', async () => {
    boot();
    const { job, app, task } = approved({
      source: 'hn_hiring',
      canonicalUrl: 'https://news.ycombinator.com/item?id=2',
      company: 'Flotive AI',
      title: 'Founding Software Engineer',
      descriptionMd: 'Flotive AI | Founding Software Engineer | NYC. Details here: https://flotive.notion.site/x',
    });

    await world.runner.drain();

    expect(world.ctx.queue.get(task.id)!.lastError).toMatch(/no contact address/i);
    expect(reloadJob(job.id).status).toBe('needs_manual');
    expect(reload(app.id).status).toBe('needs_manual');
    expect(world.ctx.db.select().from(emails).where(eq(emails.applicationId, app.id)).all()).toHaveLength(0);
  });

  it('a park carries its reason onto the task payload (captcha stays captcha)', async () => {
    boot({ mode: 'park-captcha', fetch: stubFetch({ 'https://careers.acme.com/jobs/1': '<form><input name="email"></form>' }) });
    const { task } = approved({ canonicalUrl: 'https://careers.acme.com/jobs/1', company: 'Acme', title: 'Engineer' });

    await world.runner.drain();

    const t = world.ctx.queue.get(task.id)!;
    expect(t.state).toBe('needs_human');
    expect(JSON.parse(t.payloadJson).parkReason).toBe('captcha');
  });

  it('a dead posting the driver finds mid-run expires the job instead of parking it', async () => {
    boot({ mode: 'park-dead', fetch: stubFetch({ 'https://careers.acme.com/jobs/2': '<form><input name="email"></form>' }) });
    const { job, app, task } = approved({ canonicalUrl: 'https://careers.acme.com/jobs/2', company: 'Acme', title: 'Engineer' });

    await world.runner.drain();

    const t = world.ctx.queue.get(task.id)!;
    expect(t.state).toBe('failed');
    expect(t.lastError).toBe('Posting no longer available');
    expect(reloadJob(job.id).status).toBe('expired');
    expect(reload(app.id).status).toBe('expired');
  });

  it('an unreachable posting is applied to anyway — a network blip never expires an application', async () => {
    boot({
      fetch: async () => {
        throw new Error('offline');
      },
    });
    const { app, task } = approved({ canonicalUrl: 'https://careers.acme.com/jobs/3', company: 'Acme', title: 'Engineer' });

    await world.runner.drain();

    expect(world.ctx.queue.get(task.id)!.state).toBe('done');
    expect(driver.calls).toEqual(['https://careers.acme.com/jobs/3']);
    expect(reload(app.id).status).toBe('applied');
  });
});
