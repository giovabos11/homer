import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeWorld, type TestWorld } from './helpers';

describe('token-bucket source budgets', () => {
  let world: TestWorld;

  beforeEach(() => {
    world = makeWorld({
      config: {
        budgets: {
          default: { capacity: 60, refillPerHour: 30 },
          perSource: { testsource: { capacity: 2, refillPerHour: 1 } },
        },
      },
    });
  });
  afterEach(() => world.cleanup());

  it('spends tokens down to zero, then denies with a nextRun estimate', () => {
    const b = world.ctx.budgets;
    expect(b.take('testsource').ok).toBe(true);
    expect(b.take('testsource').ok).toBe(true);
    const denied = b.take('testsource');
    expect(denied.ok).toBe(false);
    expect(denied.nextRun).not.toBeNull();
    // 1 token deficit at 1 token/hour → ~1 hour out.
    const eta = Date.parse(denied.nextRun!) - world.clock.now;
    expect(eta).toBeGreaterThan(55 * 60 * 1000);
    expect(eta).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it('refills continuously with elapsed time, capped at capacity', () => {
    const b = world.ctx.budgets;
    b.take('testsource');
    b.take('testsource'); // empty now
    expect(b.take('testsource').ok).toBe(false);

    world.clock.advance(60 * 60 * 1000); // +1h → +1 token
    expect(b.take('testsource').ok).toBe(true);
    expect(b.take('testsource').ok).toBe(false);

    world.clock.advance(100 * 60 * 60 * 1000); // huge gap → capped at capacity 2
    expect(b.take('testsource').ok).toBe(true);
    expect(b.take('testsource').ok).toBe(true);
    expect(b.take('testsource').ok).toBe(false);
  });

  it('disabled sources never grant tokens', () => {
    world.ctx.budgets.ensure('testsource');
    world.ctx.budgets.setEnabled('testsource', false);
    expect(world.ctx.budgets.take('testsource').ok).toBe(false);
    world.ctx.budgets.setEnabled('testsource', true);
    expect(world.ctx.budgets.take('testsource').ok).toBe(true);
  });

  it('unknown sources get the default budget spec', () => {
    const result = world.ctx.budgets.take('brand-new-source');
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(59); // default capacity 60 - 1
  });
});
