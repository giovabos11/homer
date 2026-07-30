// Detail enrichment: discovery fetches `detail` for new metadata-only jobs,
// the score worker fetches-before-scoring (with a capped/annotated fallback
// when nothing can be fetched), and POST /api/jobs/:id/fetch-details backfills
// on demand (portal first, agent fallback). Portal CLI + skill discovery are
// module-mocked — no bun, no network.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { NO_DESCRIPTION_NOTE, NO_DESCRIPTION_SCORE_CAP } from '../src/workers/score';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const FAKE_SKILL = {
  name: 'freehire-search',
  source: 'freehire',
  enabled: true,
  cliPath: '.agents/skills/freehire-search/cli/src/cli.ts',
  dir: '/fake/skills/freehire-search',
};

const runPortalSearch = vi.fn();
const runPortalDetail = vi.fn();

vi.mock('../src/sources/portal-cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/portal-cli')>();
  return {
    ...actual,
    runPortalSearch: (...args: unknown[]) => runPortalSearch(...args),
    runPortalDetail: (...args: unknown[]) => runPortalDetail(...args),
  };
});

vi.mock('../src/sources/skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sources/skills')>();
  return {
    ...actual,
    discoverSkills: () => [FAKE_SKILL],
    enabledSkills: () => [FAKE_SKILL],
    resolveBun: () => '/fake/bun',
  };
});

const scoreJson = {
  technical: 90, experience: 88, behavioral: 90, career: 90,
  locationVeto: false,
  legitimacy: { verdict: 'legit', reasons: ['ok'] },
};

const script = (o: { prompt: string }) => {
  if (o.prompt.includes('fit-evaluation engine')) return { text: JSON.stringify(scoreJson) };
  if (o.prompt.includes('extract the full job')) return { text: JSON.stringify({ description: 'Agent extracted description.' }) };
  return { text: 'ok' };
};

describe('job-detail enrichment', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    runPortalSearch.mockReset();
    runPortalDetail.mockReset();
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  it('discovery runs detail for NEW metadata-only hits and merges the result', async () => {
    runPortalSearch.mockResolvedValue({
      total: 2,
      hits: [
        {
          id: 'hit-full', title: 'Engineer A', company: 'FullCo', location: 'Dallas, TX',
          date: null, url: 'https://x.example/a', description: 'Already has a description.',
          workMode: 'remote', salary: null, raw: {},
        },
        {
          id: 'hit-bare', title: 'Engineer B', company: 'BareCo', location: null,
          date: null, url: 'https://x.example/b', description: null,
          workMode: null, salary: null, raw: {},
        },
      ],
    });
    runPortalDetail.mockResolvedValue({
      description: 'Fetched detail description.',
      salaryMin: 120000, salaryMax: 150000, salaryCurrency: 'USD',
      workMode: 'remote', location: 'Remote (US)',
      raw: { id: 'hit-bare' },
    });

    world.ctx.queue.enqueue('discover', { payload: { trigger: 'manual_run' } });
    await world.runner.tick(); // discover only — score tasks stay queued

    // detail called exactly once, for the bare hit.
    expect(runPortalDetail).toHaveBeenCalledTimes(1);
    expect(runPortalDetail.mock.calls[0]![2]).toBe('hit-bare');

    const bare = world.ctx.db.select().from(jobs).where(eq(jobs.company, 'BareCo')).get()!;
    expect(bare.descriptionMd).toBe('Fetched detail description.');
    expect(bare.salaryMin).toBe(120000);
    expect(bare.remoteType).toBe('remote');
    expect(JSON.parse(bare.rawJson!)).toHaveProperty('detail');

    const full = world.ctx.db.select().from(jobs).where(eq(jobs.company, 'FullCo')).get()!;
    expect(full.descriptionMd).toBe('Already has a description.');
  });

  it('score worker fetches details before scoring a metadata-only job', async () => {
    runPortalDetail.mockResolvedValue({
      description: 'Detail text for scoring.',
      salaryMin: null, salaryMax: null, salaryCurrency: null,
      workMode: null, location: null,
      raw: {},
    });
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'sc-1', canonicalUrl: 'https://x.example/sc-1',
      company: 'ScoreCo', title: 'Engineer', location: 'Dallas, TX', remoteType: 'remote',
    });
    world.ctx.queue.enqueue('score', { payload: { jobId: job.id } });
    await world.runner.tick();

    expect(runPortalDetail).toHaveBeenCalledTimes(1);
    const scoreCall = world.mockAgent.calls.find((c) => c.prompt.includes('fit-evaluation engine'))!;
    expect(scoreCall.prompt).toContain('Detail text for scoring.');

    const row = world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(row.status).toBe('screened');
    expect(JSON.parse(row.fitBreakdownJson!).note).toBeUndefined();
  });

  it('when no description can be fetched, scoring proceeds with a note and a capped score', async () => {
    runPortalDetail.mockRejectedValue(new Error('detail unavailable'));
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'sc-2', canonicalUrl: 'https://x.example/sc-2',
      company: 'NoDescCo', title: 'Engineer', location: 'Dallas, TX', remoteType: 'remote',
    });
    world.ctx.queue.enqueue('score', { payload: { jobId: job.id } });
    await world.runner.tick();

    const row = world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(row.status).toBe('screened');
    expect(row.fitScore).toBe(NO_DESCRIPTION_SCORE_CAP); // raw weighted 90 capped
    expect(JSON.parse(row.fitBreakdownJson!).note).toBe(NO_DESCRIPTION_NOTE);
  });

  it('POST /api/jobs/:id/fetch-details: portal path, then agent fallback for skill-less sources', async () => {
    // Portal path.
    runPortalDetail.mockResolvedValue({
      description: 'Portal detail.',
      salaryMin: null, salaryMax: null, salaryCurrency: null,
      workMode: null, location: null, raw: {},
    });
    const { job: portalJob } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'fd-1', canonicalUrl: 'https://x.example/fd-1',
      company: 'PortalDetailCo', title: 'Engineer', location: null, remoteType: 'remote',
    });
    const res1 = await request(app).post(`/api/jobs/${portalJob.id}/fetch-details`).expect(200);
    expect(res1.body.job.descriptionMd).toBe('Portal detail.');
    expect(world.mockAgent.calls.length).toBe(0); // no agent needed

    // Agent fallback: source without a portal skill.
    const { job: urlJob } = upsertJob(world.ctx.db, {
      source: 'url', externalId: null, canonicalUrl: 'https://careers.example.com/role/1',
      company: 'AgentFallbackCo', title: 'Engineer', location: null, remoteType: 'unknown',
    });
    const res2 = await request(app).post(`/api/jobs/${urlJob.id}/fetch-details`).expect(200);
    expect(res2.body.job.descriptionMd).toBe('Agent extracted description.');
    const agentCall = world.mockAgent.calls.at(-1)!;
    expect(agentCall.model).toBe('haiku');
    expect(agentCall.allowedTools).toEqual(['WebFetch']);
    expect(agentCall.prompt).toContain('UNTRUSTED');

    // Already-described job: no fetch at all.
    runPortalDetail.mockClear();
    const before = world.mockAgent.calls.length;
    await request(app).post(`/api/jobs/${portalJob.id}/fetch-details`).expect(200);
    expect(runPortalDetail).not.toHaveBeenCalled();
    expect(world.mockAgent.calls.length).toBe(before);

    await request(app).post('/api/jobs/999999/fetch-details').expect(404);
  });
});
