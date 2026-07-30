// Profile-sync worker (FR-14): /setup Path A semantics — additive changes are
// applied by the agent, conflicting changes queue for dashboard approval as a
// feedback entry with a planChange. MockRunner only.
import { afterEach, describe, expect, it } from 'vitest';
import { feedback } from '../src/db/schema';
import { makeFakeRepo, makeWorld, type TestWorld } from './helpers';

describe('profile_sync worker (real path, MockRunner)', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;
  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  it('conflicting changes create a feedback entry with an unapplied planChange', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('profile-sync step')
          ? {
              text: JSON.stringify({
                additiveApplied: [{ file: 'CLAUDE.md', summary: 'Added new certification' }],
                conflicts: [
                  { file: 'CLAUDE.md', description: 'Phone number differs between resume.pdf and the profile', proposal: 'Update to +1 555-020-0000' },
                ],
              }),
            }
          : { text: 'ok' },
    });
    const task = world.ctx.queue.enqueue('profile_sync', { payload: { trigger: 'documents_watcher', changed: ['documents/resume.pdf'] } });
    await world.runner.drain();
    expect(world.ctx.queue.get(task.id)!.state).toBe('done');

    const rows = world.ctx.db.select().from(feedback).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('update');
    expect(rows[0]!.responseMd).toContain('Phone number differs');
    const plan = JSON.parse(rows[0]!.planChangeJson!) as { description: string; applied: boolean; profileConflicts: unknown[] };
    expect(plan.applied).toBe(false); // waits for dashboard approval
    expect(plan.profileConflicts).toHaveLength(1);
    expect(plan.description).toContain('Phone number differs');
  });

  it('additive-only syncs apply silently — no approval entry is created', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('profile-sync step')
          ? { text: JSON.stringify({ additiveApplied: [{ file: '01-candidate-profile.md', summary: 'Added Docker to skills' }], conflicts: [] }) }
          : { text: 'ok' },
    });
    world.ctx.queue.enqueue('profile_sync', { payload: { trigger: 'documents_watcher', changed: ['documents/linkedin.pdf'] } });
    await world.runner.drain();
    expect(world.ctx.db.select().from(feedback).all()).toHaveLength(0);
  });

  it('an unparseable agent reply fails the task for retry instead of guessing', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, script: () => ({ text: 'not json at all' }) });
    const task = world.ctx.queue.enqueue('profile_sync', { payload: { changed: ['documents/resume.pdf'] } });
    await world.runner.drain();
    const after = world.ctx.queue.get(task.id)!;
    expect(['pending', 'failed']).toContain(after.state);
    expect(after.lastError).toContain('unparseable');
  });
});
