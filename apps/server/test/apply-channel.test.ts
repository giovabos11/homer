// Apply-channel classification + the idempotent backfill (PRD §11).
//
// The live database is the reason this exists: of 15 approved applications,
// only a handful pointed at an application form. Eight were whatjobs
// `pub_api__…` syndication redirects and three were Hacker News "Who is hiring"
// comment threads, and the pipeline treated all of them as forms it could drive.
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { classifyApplyChannel, extractContactEmail, isAggregatorUrl } from '../src/apply/channel';
import { backfillApplyChannels } from '../src/apply/backfill';
import { applications, jobs } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { makeWorld, type TestWorld } from './helpers';

describe('classifyApplyChannel', () => {
  it('recognizes the real ATS hosts as forms', () => {
    for (const url of [
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://job-boards.greenhouse.io/warp/jobs/4324888004?utm_source=freehire.me',
      'https://jobs.lever.co/acme/9d2f',
      'https://jobs.ashbyhq.com/mintmcp/b3334a8b-521e-4989-82b1-988ff52a2671',
      'https://apply.workable.com/acme/j/ABC/',
      'https://jobs.smartrecruiters.com/Acme/744000',
      'https://usbank.wd1.myworkdayjobs.com/en-US/careers/job/123',
      'https://recruiting.ultipro.com/tco1001tcom/JobBoard/74e5/OpportunityDetail?opportunityId=5be6',
      'https://sealing-technologies-inc.breezy.hr/p/abc',
    ]) {
      expect(classifyApplyChannel({ canonicalUrl: url })).toBe('ats_form');
    }
  });

  it('treats a company careers page as a form (that is where the apply button is)', () => {
    expect(classifyApplyChannel({ canonicalUrl: 'https://abnormal.ai/careers/jobs/7814567003?gh_jid=7814567003' })).toBe('ats_form');
    expect(classifyApplyChannel({ canonicalUrl: 'https://careers.datadoghq.com/detail/1234/' })).toBe('ats_form');
  });

  it('flags whatjobs pub_api links and friends as aggregator redirects', () => {
    const live = 'https://www.whatjobs.com/pub_api__cpl__2626788452__7065?geoID=2251&utm_source=freehire.me';
    expect(isAggregatorUrl(live)).toBe(true);
    expect(classifyApplyChannel({ canonicalUrl: live, source: 'freehire' })).toBe('aggregator_redirect');
    expect(classifyApplyChannel({ canonicalUrl: 'https://www.talent.com/view?id=abc' })).toBe('aggregator_redirect');
    expect(classifyApplyChannel({ canonicalUrl: 'https://example.com/redirect?to=acme' })).toBe('aggregator_redirect');
  });

  it('an ATS apply path is never mistaken for a redirect', () => {
    expect(isAggregatorUrl('https://jobs.lever.co/acme/9d2f/apply')).toBe(false);
    expect(classifyApplyChannel({ canonicalUrl: 'https://jobs.ashbyhq.com/nuna/7b95/application' })).toBe('ats_form');
  });

  it('HN threads and mailto links are the email channel', () => {
    expect(classifyApplyChannel({ canonicalUrl: 'https://news.ycombinator.com/item?id=48756811' })).toBe('email');
    expect(classifyApplyChannel({ canonicalUrl: 'https://example.com/x', source: 'hn_hiring' })).toBe('email');
    expect(classifyApplyChannel({ canonicalUrl: 'mailto:jobs@acme.com' })).toBe('email');
  });

  it('no URL is email when the posting carries an address, otherwise unknown', () => {
    expect(classifyApplyChannel({ canonicalUrl: '', descriptionMd: 'Write to careers@acme.com' })).toBe('email');
    expect(classifyApplyChannel({ canonicalUrl: '', descriptionMd: 'No way in.' })).toBe('unknown');
    expect(classifyApplyChannel({ canonicalUrl: 'https://t.me/somechannel' })).toBe('unknown');
  });

  it('is a pure function of the row — the same input always lands on the same channel', () => {
    const input = { canonicalUrl: 'https://www.whatjobs.com/pub_api__cpl__1__2', source: 'freehire' };
    expect(classifyApplyChannel(input)).toBe(classifyApplyChannel(input));
  });
});

describe('extractContactEmail', () => {
  it('pulls the address out of real HN comment text', () => {
    expect(extractContactEmail('OneChronos | Engineer | Remote. Email careers@onechronos.com to apply.')).toBe(
      'careers@onechronos.com',
    );
    expect(extractContactEmail('Reach out to kjackson@rabbet.com with a resume')).toBe('kjackson@rabbet.com');
  });

  it('prefers the address the text points at over a bare mention', () => {
    const text = 'Our product is at hello@marketing.acme.com. To apply, email your resume to jobs@acme.com.';
    expect(extractContactEmail(text)).toBe('jobs@acme.com');
  });

  it('refuses no-reply and placeholder addresses rather than drafting into a void', () => {
    expect(extractContactEmail('Questions? no-reply@acme.com')).toBeNull();
    expect(extractContactEmail('e.g. you@example.com')).toBeNull();
    expect(extractContactEmail('Apply on our site.')).toBeNull();
    expect(extractContactEmail(null)).toBeNull();
  });
});

describe('backfillApplyChannels', () => {
  let world: TestWorld;
  const seed = () => {
    world = makeWorld();
    const mk = (over: Partial<Parameters<typeof upsertJob>[1]> & { company: string; canonicalUrl: string }) =>
      upsertJob(world.ctx.db, {
        source: 'freehire',
        externalId: over.company,
        title: 'Software Engineer',
        location: null,
        remoteType: 'remote',
        ...over,
      } as Parameters<typeof upsertJob>[1]).job;
    return {
      ats: mk({ company: 'Warp', canonicalUrl: 'https://job-boards.greenhouse.io/warp/jobs/4324888004' }),
      agg: mk({ company: 'Harnham', canonicalUrl: 'https://www.whatjobs.com/pub_api__cpl__2626788452__7065?geoID=2251' }),
      hn: mk({
        company: 'Annex Risk',
        source: 'hn_hiring',
        canonicalUrl: 'https://news.ycombinator.com/item?id=48756811',
        descriptionMd: 'Annex Risk | Full-stack. Email jobs@annexrisk.com.',
      }),
    };
  };

  it('classifies every job and is idempotent on a second pass', () => {
    seed();
    try {
      // Wipe the intake-time classification so this exercises the real backfill.
      world.ctx.db.update(jobs).set({ applyChannel: 'unknown' }).run();

      const first = backfillApplyChannels(world.ctx.db);
      expect(first.scanned).toBe(3);
      expect(first.updated).toBe(3);
      expect(first.counts).toMatchObject({ ats_form: 1, aggregator_redirect: 1, email: 1 });

      const second = backfillApplyChannels(world.ctx.db);
      expect(second.updated).toBe(0);
      expect(second.flagged).toBe(0);
      expect(second.counts).toEqual(first.counts);
    } finally {
      world.cleanup();
    }
  });

  it('flags approved applications that cannot be auto-submitted, once', () => {
    const rows = seed();
    try {
      const now = new Date().toISOString();
      const approve = (jobId: number) =>
        world.ctx.db
          .insert(applications)
          .values({ jobId, status: 'ready_for_review', gate: 'review', approvedAt: now, createdAt: now, updatedAt: now })
          .returning()
          .get();
      const atsApp = approve(rows.ats.id);
      const aggApp = approve(rows.agg.id);
      const hnApp = approve(rows.hn.id);

      const first = backfillApplyChannels(world.ctx.db);
      expect(first.approved.total).toBe(3);
      expect(first.approved.notAutoApplyable).toBe(2);
      expect(first.approved.byChannel).toMatchObject({ ats_form: 1, aggregator_redirect: 1, email: 1 });
      expect(first.flagged).toBe(2);

      const advisoriesOf = (id: number) =>
        JSON.parse(world.ctx.db.select().from(applications).where(eq(applications.id, id)).get()!.advisoriesJson) as {
          text: string;
        }[];
      expect(advisoriesOf(atsApp.id)).toHaveLength(0);
      expect(advisoriesOf(aggApp.id)[0]!.text).toMatch(/aggregator redirect/i);
      expect(advisoriesOf(hnApp.id)[0]!.text).toMatch(/applied to by email/i);

      // Second run adds nothing — advisories merge by normalized text.
      expect(backfillApplyChannels(world.ctx.db).flagged).toBe(0);
      expect(advisoriesOf(aggApp.id)).toHaveLength(1);
    } finally {
      world.cleanup();
    }
  });

  it('a submitted application is not re-flagged (the work is already done)', () => {
    const rows = seed();
    try {
      const now = new Date().toISOString();
      world.ctx.db
        .insert(applications)
        .values({
          jobId: rows.agg.id, status: 'applied', gate: 'review',
          approvedAt: now, submittedAt: now, createdAt: now, updatedAt: now,
        })
        .run();
      const r = backfillApplyChannels(world.ctx.db);
      expect(r.approved.total).toBe(0);
      expect(r.flagged).toBe(0);
    } finally {
      world.cleanup();
    }
  });
});
