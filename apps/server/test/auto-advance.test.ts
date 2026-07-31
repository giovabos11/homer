// FR-9 auto-advance: after scoring, screened+legit+non-vetoed jobs that meet
// the configured gate flow into tailoring automatically; the submit gate is
// untouched. MockRunner-scripted score results; no tailor task is ever drained
// here (we assert enqueueing, not the tailor pipeline).
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applications } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { maybeAutoAdvance } from '../src/workers/score';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const base = {
  technical: 90, experience: 85, behavioral: 88, career: 84,
  locationVeto: false,
  legitimacy: { verdict: 'legit' as const, reasons: ['ok'] },
};

const script = (o: { prompt: string }) => {
  if (!o.prompt.includes('fit-evaluation engine')) return { text: 'ok' };
  if (o.prompt.includes('SuspiciousCo')) {
    return { text: JSON.stringify({ ...base, legitimacy: { verdict: 'suspicious', reasons: ['no web presence'] } }) };
  }
  if (o.prompt.includes('VetoCo')) return { text: JSON.stringify({ ...base, locationVeto: true }) };
  if (o.prompt.includes('LowFitCo')) {
    return { text: JSON.stringify({ ...base, technical: 40, experience: 40, behavioral: 40, career: 40 }) };
  }
  return { text: JSON.stringify(base) };
};

describe('auto-advance after scoring', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;
  let seq = 0;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  function makeJob(company: string) {
    seq += 1;
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: `aa-${seq}`,
      canonicalUrl: `https://x.example/aa-${seq}`,
      company,
      title: 'Engineer',
      location: 'Dallas, TX',
      remoteType: 'remote',
      descriptionMd: `${company} is hiring. Long enough description for scoring.`,
    });
    return job;
  }

  function tailorTasksFor(jobId: number): number {
    return world.ctx.queue
      .list()
      .filter((t) => t.type === 'tailor' && (JSON.parse(t.payloadJson) as { jobId?: number }).jobId === jobId).length;
  }

  async function scoreOnly(jobId: number): Promise<void> {
    world.ctx.queue.enqueue('score', { payload: { jobId } });
    await world.runner.tick(); // exactly one task: the score — tailor is only enqueued
  }

  it('threshold mode (default 70): high-fit legit job flows into tailoring', async () => {
    const job = makeJob('GreatFitCo');
    await scoreOnly(job.id);
    expect(tailorTasksFor(job.id)).toBe(1);
    const row = world.ctx.queue.list().find((t) => t.type === 'tailor')!;
    expect((JSON.parse(row.payloadJson) as { trigger?: string }).trigger).toBe('auto_advance');
  });

  it('below threshold, suspicious, and location-vetoed jobs stay in screened', async () => {
    const low = makeJob('LowFitCo'); // weighted 40 < 70
    await scoreOnly(low.id);
    expect(tailorTasksFor(low.id)).toBe(0);

    const sus = makeJob('SuspiciousCo');
    await scoreOnly(sus.id);
    expect(tailorTasksFor(sus.id)).toBe(0);

    const veto = makeJob('VetoCo');
    await scoreOnly(veto.id);
    expect(tailorTasksFor(veto.id)).toBe(0);
  });

  it('mode off never advances; mode all advances regardless of threshold', async () => {
    await request(app).patch('/api/settings').send({ autoAdvance: 'off' }).expect(200);
    const a = makeJob('OffModeCo');
    await scoreOnly(a.id);
    expect(tailorTasksFor(a.id)).toBe(0);

    await request(app).patch('/api/settings').send({ autoAdvance: 'all', autoAdvanceThreshold: 99 }).expect(200);
    // The settings change triggers the backfill sweep — OffModeCo (screened
    // while advance was off) is retro-advanced at priority 5.
    expect(tailorTasksFor(a.id)).toBe(1);
    const backfill = world.ctx.queue.list().find((t) => t.type === 'tailor')!;
    expect((JSON.parse(backfill.payloadJson) as { trigger?: string }).trigger).toBe('auto_advance_backfill');
    expect(backfill.priority).toBe(5);
    world.ctx.queue.cancel(backfill.id); // keep the next tick focused on b's score

    const b = makeJob('LowFitCo Two'); // fit 40 — 'all' ignores the threshold
    await scoreOnly(b.id);
    expect(tailorTasksFor(b.id)).toBe(1);
  });

  it('dedupes against existing applications and active tailor tasks', async () => {
    const job = makeJob('DedupCo');
    await scoreOnly(job.id);
    expect(tailorTasksFor(job.id)).toBe(1);

    // Re-running the advance decision is a no-op while the tailor task is active.
    const row = world.ctx.db.select().from(applications).all(); // no application yet
    expect(row.length).toBe(0);
    const advancedAgain = maybeAutoAdvance(world.ctx, {
      ...job,
      status: 'screened',
      legitVerdict: 'legit',
      fitScore: 85,
      fitBreakdownJson: JSON.stringify({ technical: 85, experience: 85, behavioral: 85, career: 85, locationVeto: false }),
    });
    expect(advancedAgain).toBe(false);
    expect(tailorTasksFor(job.id)).toBe(1);

    // With an application record present it is also a no-op.
    const now = new Date().toISOString();
    world.ctx.db.insert(applications).values({ jobId: job.id, status: 'tailoring', gate: 'review', createdAt: now, updatedAt: now }).run();
    world.ctx.queue.cancel(world.ctx.queue.list().find((t) => t.type === 'tailor')!.id);
    expect(
      maybeAutoAdvance(world.ctx, {
        ...job,
        status: 'screened',
        legitVerdict: 'legit',
        fitScore: 85,
        fitBreakdownJson: JSON.stringify({ technical: 85, experience: 85, behavioral: 85, career: 85, locationVeto: false }),
      }),
    ).toBe(false);
  });

  it('manual records are never auto-advanced', () => {
    seq += 1;
    const { job } = upsertJob(world.ctx.db, {
      source: 'manual',
      externalId: `aa-${seq}`,
      canonicalUrl: '',
      company: 'ManualCo',
      title: 'Engineer',
      location: null,
      remoteType: 'unknown',
      managed: 'manual',
    });
    expect(
      maybeAutoAdvance(world.ctx, { ...job, status: 'screened', legitVerdict: 'legit', fitScore: 95 }),
    ).toBe(false);
    expect(tailorTasksFor(job.id)).toBe(0);
  });
});
