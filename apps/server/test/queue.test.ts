import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from './helpers';
import { registerWorker, PauseRequested } from '../src/workers/registry';

describe('task queue', () => {
  let world: TestWorld;

  beforeEach(() => {
    world = makeWorld({ config: { queue: { maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 60000, pollIntervalMs: 50, followupSweepCron: '0 9 * * *' } } });
  });
  afterEach(() => world.cleanup());

  it('claims pending tasks FIFO and atomically', () => {
    const a = world.ctx.queue.enqueue('score', { payload: { jobId: 1 } });
    const b = world.ctx.queue.enqueue('score', { payload: { jobId: 2 } });
    const first = world.ctx.queue.claim();
    expect(first?.id).toBe(a.id);
    expect(first?.state).toBe('running');
    const second = world.ctx.queue.claim();
    expect(second?.id).toBe(b.id);
    expect(world.ctx.queue.claim()).toBeNull();
  });

  it('respects run_after scheduling', () => {
    world.ctx.queue.enqueue('score', { runAfter: new Date(world.clock.now + 60000) });
    expect(world.ctx.queue.claim()).toBeNull();
    world.clock.advance(61000);
    expect(world.ctx.queue.claim()).not.toBeNull();
  });

  it('retries with exponential backoff and fails at the attempts cap', () => {
    const task = world.ctx.queue.enqueue('score');
    // attempt 1
    world.ctx.queue.claim();
    let row = world.ctx.queue.fail(task.id, 'boom 1');
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    const delay1 = Date.parse(row.runAfter!) - world.clock.now;
    expect(delay1).toBeGreaterThanOrEqual(1000);

    world.clock.advance(delay1 + 1);
    // attempt 2 — backoff doubles
    expect(world.ctx.queue.claim()?.id).toBe(task.id);
    row = world.ctx.queue.fail(task.id, 'boom 2');
    expect(row.state).toBe('pending');
    const delay2 = Date.parse(row.runAfter!) - world.clock.now;
    expect(delay2).toBeGreaterThanOrEqual(2000);
    expect(delay2).toBeGreaterThan(delay1 - 1000);

    world.clock.advance(delay2 + 1);
    // attempt 3 = cap (maxAttempts 3) → failed
    expect(world.ctx.queue.claim()?.id).toBe(task.id);
    row = world.ctx.queue.fail(task.id, 'boom 3');
    expect(row.state).toBe('failed');
    expect(row.lastError).toBe('boom 3');
    expect(world.ctx.queue.claim()).toBeNull();
  });

  it('global pause stops claiming; resume wakes parked tasks with cursor intact', () => {
    const task = world.ctx.queue.enqueue('discover');
    world.ctx.queue.setPaused(true);
    expect(world.ctx.queue.claim()).toBeNull();

    // A running worker parks itself with its cursor.
    world.ctx.queue.saveCursor(task.id, { sourceIndex: 1, page: 3 });
    world.ctx.queue.pauseTask(task.id);
    expect(world.ctx.queue.get(task.id)?.state).toBe('paused');

    world.ctx.queue.setPaused(false);
    const resumed = world.ctx.queue.get(task.id);
    expect(resumed?.state).toBe('pending');
    expect(JSON.parse(resumed!.cursorJson!)).toEqual({ sourceIndex: 1, page: 3 });
  });

  it('needs_human → resolve-human resumes from cursor', () => {
    const task = world.ctx.queue.enqueue('apply');
    world.ctx.queue.claim();
    world.ctx.queue.saveCursor(task.id, { step: 'captcha' });
    const parked = world.ctx.queue.needsHuman(task.id, 'Solve the captcha');
    expect(parked.state).toBe('needs_human');
    expect(parked.humanPrompt).toBe('Solve the captcha');

    const resumed = world.ctx.queue.resolveHuman(task.id);
    expect(resumed.state).toBe('pending');
    expect(resumed.humanPrompt).toBeNull();
    expect(JSON.parse(resumed.cursorJson!)).toEqual({ step: 'captcha' });
  });

  it('cancel marks the task failed with an explicit marker', () => {
    const task = world.ctx.queue.enqueue('score');
    const row = world.ctx.queue.cancel(task.id);
    expect(row.state).toBe('failed');
    expect(row.lastError).toBe('Cancelled by user');
  });

  it('dedupe enqueue skips when an identical-type task is already pending', () => {
    const a = world.ctx.queue.enqueue('email_scan', { dedupe: true });
    const b = world.ctx.queue.enqueue('email_scan', { dedupe: true });
    expect(b.id).toBe(a.id);
  });

  it('worker resumes from its saved cursor after pause/resume (runner integration)', async () => {
    const processed: number[] = [];
    let pauseAfter = 2;
    registerWorker({
      type: 'discover',
      async run({ task, paused, saveCursor }) {
        const cursor = task.cursorJson ? (JSON.parse(task.cursorJson) as { i: number }) : { i: 0 };
        for (let i = cursor.i; i < 5; i += 1) {
          if (paused()) {
            saveCursor({ i });
            throw new PauseRequested();
          }
          processed.push(i);
          saveCursor({ i: i + 1 });
          if (processed.length === pauseAfter) world.ctx.queue.setPaused(true);
        }
      },
    });

    const task = world.ctx.queue.enqueue('discover');
    await world.runner.tick();
    // Pause flag set after item 1; observed at the top of the next iteration.
    expect(world.ctx.queue.get(task.id)?.state).toBe('paused');
    expect(processed).toEqual([0, 1]);
    expect(JSON.parse(world.ctx.queue.get(task.id)!.cursorJson!)).toEqual({ i: 2 });

    pauseAfter = Number.POSITIVE_INFINITY;
    world.ctx.queue.setPaused(false);
    await world.runner.tick();
    expect(world.ctx.queue.get(task.id)?.state).toBe('done');
    expect(processed).toEqual([0, 1, 2, 3, 4]);
  });
});
