// Bounded queue concurrency (slot-pool runner): up to queueConcurrency
// agent-bound tasks in flight at once, apply/discover always serialized (but
// apply may run alongside agents), per-slot crash isolation, and
// priority-ordered claiming (priority DESC, FIFO within a band).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWorker } from '../src/workers/registry';
import { makeWorld, type TestWorld } from './helpers';

/** Flush enough microtask/timer turns for released workers to finish. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

describe('priority-ordered claiming', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => world.cleanup());

  it('claims higher priority first, FIFO within a band', () => {
    const bulk = world.ctx.queue.enqueue('score', { priority: 0 });
    const userA = world.ctx.queue.enqueue('tailor', { priority: 10 });
    const userB = world.ctx.queue.enqueue('ask', { priority: 10 });
    const advance = world.ctx.queue.enqueue('tailor', { priority: 5 });

    expect(world.ctx.queue.claim()?.id).toBe(userA.id); // 10, oldest first
    expect(world.ctx.queue.claim()?.id).toBe(userB.id); // 10
    expect(world.ctx.queue.claim()?.id).toBe(advance.id); // 5
    expect(world.ctx.queue.claim()?.id).toBe(bulk.id); // 0
  });

  it('claim(types) only claims matching task types', () => {
    world.ctx.queue.enqueue('discover', { priority: 10 });
    const score = world.ctx.queue.enqueue('score', { priority: 0 });
    expect(world.ctx.queue.claim(['score', 'tailor'])?.id).toBe(score.id);
    expect(world.ctx.queue.claim(['score', 'tailor'])).toBeNull();
    expect(world.ctx.queue.claim([])).toBeNull();
  });

  it('positionOf counts running tasks and claim-ordered-earlier pending tasks', () => {
    world.ctx.queue.enqueue('score', { priority: 0 });
    world.ctx.queue.claim(); // → running
    const bulk = world.ctx.queue.enqueue('score', { priority: 0 });
    const user = world.ctx.queue.enqueue('tailor', { priority: 10 });

    expect(world.ctx.queue.positionOf(user.id)).toBe(1); // only the running task is ahead
    expect(world.ctx.queue.positionOf(bulk.id)).toBe(2); // running + the higher-priority tailor
  });
});

describe('slot-pool runner concurrency', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => world.cleanup());

  /** Replace a worker with one that parks until released. */
  function gateWorker(type: 'score' | 'tailor' | 'apply' | 'discover', started: number[]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    registerWorker({
      type,
      async run({ task }) {
        started.push(task.id);
        await gate;
      },
    });
    return () => release();
  }

  it('runs up to queueConcurrency agent tasks in parallel, respecting the cap', async () => {
    world.ctx.settings.patch({ queueConcurrency: 2 });
    const started: number[] = [];
    const release = gateWorker('score', started);

    const a = world.ctx.queue.enqueue('score');
    const b = world.ctx.queue.enqueue('score');
    const c = world.ctx.queue.enqueue('score');

    expect(world.runner.fillSlots()).toBe(2); // cap 2 — third stays pending
    expect(started).toEqual([a.id, b.id]);
    expect(world.ctx.queue.get(a.id)?.state).toBe('running');
    expect(world.ctx.queue.get(b.id)?.state).toBe('running');
    expect(world.ctx.queue.get(c.id)?.state).toBe('pending');
    expect(world.runner.fillSlots()).toBe(0); // still full

    release();
    await flush();
    expect(world.ctx.queue.get(a.id)?.state).toBe('done');
    expect(world.ctx.queue.get(b.id)?.state).toBe('done');
    expect(world.runner.fillSlots()).toBe(1); // freed slots pick up the third
    expect(started).toEqual([a.id, b.id, c.id]);
  });

  it('raising queueConcurrency widens the pool (max 4)', () => {
    world.ctx.settings.patch({ queueConcurrency: 4 });
    const started: number[] = [];
    gateWorker('score', started);
    for (let i = 0; i < 5; i += 1) world.ctx.queue.enqueue('score');
    expect(world.runner.fillSlots()).toBe(4);
  });

  it('apply is serialized (max 1) but runs alongside the agent pool', async () => {
    world.ctx.settings.patch({ queueConcurrency: 2 });
    const agentStarted: number[] = [];
    const applyStarted: number[] = [];
    gateWorker('score', agentStarted);
    gateWorker('apply', applyStarted);

    const apply1 = world.ctx.queue.enqueue('apply', { priority: 10 });
    const apply2 = world.ctx.queue.enqueue('apply', { priority: 10 });
    const s1 = world.ctx.queue.enqueue('score');
    const s2 = world.ctx.queue.enqueue('score');

    // 1 apply + 2 agent slots fill; the second apply must wait.
    expect(world.runner.fillSlots()).toBe(3);
    expect(applyStarted).toEqual([apply1.id]);
    expect(agentStarted).toEqual([s1.id, s2.id]);
    expect(world.ctx.queue.get(apply2.id)?.state).toBe('pending');
    expect(world.runner.fillSlots()).toBe(0);
  });

  it('discover is serialized to one in flight', () => {
    const started: number[] = [];
    gateWorker('discover', started);
    const d1 = world.ctx.queue.enqueue('discover');
    world.ctx.queue.enqueue('discover');
    expect(world.runner.fillSlots()).toBe(1);
    expect(started).toEqual([d1.id]);
  });

  it('a crashing task is isolated: it fails its slot, the others finish, the loop lives', async () => {
    world.ctx.settings.patch({ queueConcurrency: 2 });
    let releaseGood!: () => void;
    const goodGate = new Promise<void>((r) => {
      releaseGood = r;
    });
    const ran: string[] = [];
    registerWorker({
      type: 'score',
      async run({ task }) {
        const payload = JSON.parse(task.payloadJson) as { crash?: boolean };
        if (payload.crash) throw new Error('worker exploded');
        ran.push('good');
        await goodGate;
      },
    });

    const bad = world.ctx.queue.enqueue('score', { payload: { crash: true } });
    const good = world.ctx.queue.enqueue('score', { payload: {} });
    expect(world.runner.fillSlots()).toBe(2);
    await flush();

    const badRow = world.ctx.queue.get(bad.id)!;
    expect(badRow.state).toBe('pending'); // failed → retry with backoff
    expect(badRow.attempts).toBe(1);
    expect(badRow.lastError).toBe('worker exploded');

    releaseGood();
    await flush();
    expect(world.ctx.queue.get(good.id)?.state).toBe('done');

    // The loop is alive: new work still gets claimed.
    const next = world.ctx.queue.enqueue('score', { payload: {} });
    releaseGood();
    expect(world.runner.fillSlots()).toBe(1);
    await flush();
    expect(world.ctx.queue.get(next.id)?.state).toBe('done');
    expect(ran.length).toBe(2);
  });
});
