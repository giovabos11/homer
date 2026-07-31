// Task cancellation (PRD §11): a RUNNING task can be stopped, its agent call
// is aborted (which kills the CLI child in production), the slot frees, and
// half-finished pipeline state is rolled back.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs, taskQueue } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { MockRunner } from '../src/agent/mock-runner';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

describe('cancel a running task', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  it('aborts the in-flight agent call, marks it cancelled, and frees the slot', async () => {
    // A runner that parks until the task's signal fires — stands in for a long
    // `claude -p` child process.
    let aborted = false;
    world.ctx.runner = {
      run: (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    };

    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'cancel-1', canonicalUrl: 'https://example.com/c1',
      company: 'Cancel Co', title: 'Engineer', location: null, remoteType: 'remote',
      descriptionMd: 'desc', status: 'screened',
    });
    world.ctx.db.update(jobs).set({ fitScore: 80, legitVerdict: 'legit' }).where(eq(jobs.id, job.id)).run();
    const task = world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });

    const running = world.runner.tick(); // never resolves until cancelled
    await new Promise((r) => setTimeout(r, 60));
    expect(world.runner.inFlightCount()).toBe(1);
    expect(world.ctx.cancellations.isRunning(task.id)).toBe(true);

    const res = await request(app).post(`/api/queue/tasks/${task.id}/cancel`).expect(200);
    expect(res.body.aborted).toBe(true);
    await running;

    expect(aborted).toBe(true);
    expect(world.runner.inFlightCount()).toBe(0);
    const row = world.ctx.queue.get(task.id)!;
    expect(row.state).toBe('failed');
    expect(row.lastError).toBe('Cancelled by user');
    // Rollback: the job does not stay stuck in 'tailoring'.
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('screened');
  });

  it('retry-failed still skips user-cancelled tasks, but a manual retry works', async () => {
    const t = world.ctx.queue.enqueue('score', { payload: { jobId: 1 } });
    world.ctx.queue.cancel(t.id);
    const bulk = await request(app).post('/api/queue/retry-failed').send({}).expect(200);
    expect(bulk.body.requeued).toBe(0);
    expect(world.ctx.queue.get(t.id)!.state).toBe('failed');

    await request(app).post(`/api/queue/tasks/${t.id}/retry`).expect(200);
    expect(world.ctx.queue.get(t.id)!.state).toBe('pending');
  });

  it('cancel-all scopes to running, pending, or both', async () => {
    const a = world.ctx.queue.enqueue('score', { payload: {} });
    const b = world.ctx.queue.enqueue('score', { payload: {} });
    const pendingOnly = await request(app).post('/api/queue/cancel-all').send({ scope: 'pending' }).expect(200);
    expect(pendingOnly.body.cancelled).toBe(2);
    expect(world.ctx.queue.get(a.id)!.lastError).toBe('Cancelled by user');
    expect(world.ctx.queue.get(b.id)!.lastError).toBe('Cancelled by user');

    const c = world.ctx.queue.enqueue('tailor', { payload: {} });
    const typed = await request(app).post('/api/queue/cancel-all').send({ scope: 'all', type: 'score' }).expect(200);
    expect(typed.body.cancelled).toBe(0); // both score tasks are already failed
    expect(world.ctx.queue.get(c.id)!.state).toBe('pending');

    const all = await request(app).post('/api/queue/cancel-all').send({ scope: 'all' }).expect(200);
    expect(all.body.cancelled).toBe(1);
    expect(world.ctx.db.select().from(taskQueue).where(eq(taskQueue.id, c.id)).get()!.state).toBe('failed');
  });

  it('MockRunner rejects immediately when handed an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new MockRunner().run({ prompt: 'hi', signal: controller.signal })).rejects.toThrow();
  });
});
