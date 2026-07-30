// Zombie recovery + bulk retry + legitimacy override:
//  - stale 'running' claims are requeued with attempts preserved,
//  - jobs stuck in 'tailoring' with no live tailor task fall back to 'screened',
//  - skipped-with-scam-verdict jobs are repaired to 'quarantined',
//  - POST /api/queue/retry-failed resets failed tasks (cancellations excluded),
//  - POST /api/jobs/:id/override-legit flips the verdict and rescores.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { reclaimStaleTasks, recoverStuckTailoringJobs, repairQuarantinedStatuses, STALE_CLAIM_MS } from '../src/queue/recovery';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const scoreJson = {
  technical: 82, experience: 74, behavioral: 80, career: 78,
  locationVeto: false,
  legitimacy: { verdict: 'legit', reasons: ['verified (mock)'] },
};

const script = (o: { prompt: string }) => {
  if (o.prompt.includes('fit-evaluation engine')) return { text: JSON.stringify(scoreJson) };
  return { text: 'ok — mock reply' };
};

describe('zombie recovery & bulk retry', () => {
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

  function makeJob(patch: Partial<typeof jobs.$inferSelect> = {}) {
    seq += 1;
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: `rec-${seq}`,
      canonicalUrl: `https://x.example/rec-${seq}`,
      company: `RecoveryCo ${seq}`,
      title: 'Engineer',
      location: 'Dallas, TX',
      remoteType: 'remote',
      descriptionMd: 'A perfectly ordinary job description for testing recovery paths.',
    });
    if (Object.keys(patch).length === 0) return job;
    return world.ctx.db.update(jobs).set(patch).where(eq(jobs.id, job.id)).returning().get();
  }

  it('reclaims stale running claims with attempts preserved and a reclaim note', () => {
    const task = world.ctx.queue.enqueue('score', { payload: { jobId: 1 } });
    world.ctx.queue.claim();
    world.ctx.queue.fail(task.id, 'boom'); // attempts → 1, pending w/ backoff
    world.clock.advance(2 * STALE_CLAIM_MS);
    world.ctx.queue.claim(); // running again, attempts still 1
    expect(world.ctx.queue.get(task.id)?.state).toBe('running');

    world.clock.advance(STALE_CLAIM_MS + 1000);
    const n = reclaimStaleTasks(world.ctx, STALE_CLAIM_MS);
    expect(n).toBe(1);
    const row = world.ctx.queue.get(task.id)!;
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1); // preserved
    expect(row.lastError).toBe('reclaimed after stale run');
  });

  it('does not steal a live (recent) running claim', () => {
    world.ctx.queue.enqueue('score');
    world.ctx.queue.claim();
    expect(reclaimStaleTasks(world.ctx, STALE_CLAIM_MS)).toBe(0);
  });

  it('jobs stuck in tailoring with no live tailor task revert to screened', () => {
    const stuck = makeJob({ status: 'tailoring' });
    const alive = makeJob({ status: 'tailoring' });
    world.ctx.queue.enqueue('tailor', { payload: { jobId: alive.id } }); // live task → not stuck

    const n = recoverStuckTailoringJobs(world.ctx);
    expect(n).toBe(1);
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, stuck.id)).get()?.status).toBe('screened');
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, alive.id)).get()?.status).toBe('tailoring');
  });

  it('repairs skipped-with-scam-verdict jobs to quarantined', () => {
    const job = makeJob({ status: 'skipped', legitVerdict: 'scam' });
    const n = repairQuarantinedStatuses(world.ctx);
    expect(n).toBe(1);
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.status).toBe('quarantined');
  });

  it('POST /api/queue/retry-failed resets failed tasks but leaves user cancellations', async () => {
    // Force terminal failure quickly: fail up to the default cap.
    const failed = world.ctx.queue.enqueue('score', { payload: { jobId: 900 } });
    world.ctx.queue.claim();
    for (let i = 0; i < world.ctx.config.queue.maxAttempts; i += 1) world.ctx.queue.fail(failed.id, 'parse error');
    expect(world.ctx.queue.get(failed.id)?.state).toBe('failed');

    const cancelled = world.ctx.queue.enqueue('tailor', { payload: { jobId: 901 } });
    world.ctx.queue.cancel(cancelled.id);

    const wrongType = await request(app).post('/api/queue/retry-failed').send({ type: 'discover' }).expect(200);
    expect(wrongType.body.requeued).toBe(0);

    const res = await request(app).post('/api/queue/retry-failed').send({}).expect(200);
    expect(res.body.requeued).toBe(1);
    const row = world.ctx.queue.get(failed.id)!;
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(world.ctx.queue.get(cancelled.id)?.state).toBe('failed'); // cancellation respected
  });

  it('GET /api/queue includes scheduler nextRuns in the snapshot', async () => {
    const res = await request(app).get('/api/queue').expect(200);
    expect(res.body).toHaveProperty('nextRuns');
    expect(res.body.nextRuns).toHaveProperty('discover');
  });

  it('POST /api/jobs/:id/override-legit flips verdict, appends the note, and rescores', async () => {
    const job = makeJob({
      status: 'quarantined',
      legitVerdict: 'scam',
      legitReasonsJson: JSON.stringify(['Posting involves cashing or depositing checks for the employer']),
    });

    const res = await request(app)
      .post(`/api/jobs/${job.id}/override-legit`)
      .send({ verdict: 'legit', note: 'Verified: real Duolingo posting, disclaimer false positive' })
      .expect(200);
    expect(res.body.job.legitVerdict).toBe('legit');
    expect(res.body.job.status).toBe('screened');
    expect(res.body.job.legitReasons.at(-1)).toBe('[user override: Verified: real Duolingo posting, disclaimer false positive]');
    expect(res.body.taskId).not.toBeNull();

    // The queued rescore runs even though the job is no longer 'discovered'.
    // (tick once: run only the score task — a high mock fit score would
    // auto-advance the job into tailoring on a full drain.)
    await world.runner.tick();
    const after = world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(after.fitScore).not.toBeNull();
    expect(after.legitVerdict).toBe('legit');
  });

  it('override-legit validates the body and 404s on unknown jobs', async () => {
    await request(app).post('/api/jobs/999999/override-legit').send({ verdict: 'legit', note: 'x' }).expect(404);
    const job = makeJob({ status: 'quarantined', legitVerdict: 'scam' });
    await request(app).post(`/api/jobs/${job.id}/override-legit`).send({ verdict: 'scam', note: 'x' }).expect(400);
    await request(app).post(`/api/jobs/${job.id}/override-legit`).send({ verdict: 'legit' }).expect(400);
  });

  it('skip keeps scam-verdict jobs quarantined instead of burying them in skipped', async () => {
    const job = makeJob({ status: 'quarantined', legitVerdict: 'scam' });
    const res = await request(app).post(`/api/jobs/${job.id}/skip`).expect(200);
    expect(res.body.status).toBe('quarantined');

    const normal = makeJob();
    const res2 = await request(app).post(`/api/jobs/${normal.id}/skip`).expect(200);
    expect(res2.body.status).toBe('skipped');
  });
});
