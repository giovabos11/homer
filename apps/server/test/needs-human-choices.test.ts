// Parked-with-options round trip (FR-25): the apply driver attaches the real
// option list to the needs_human task payload, and resolving the task with the
// user's picks writes them back onto the application's screening answers.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isNeedsUserAnswer } from '@shared/types';
import { applications } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { ApplyBlocked, type ApplyDriver, type ApplyRunArgs } from '../src/apply/driver';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

/** Driver stand-in that parks exactly the way the Playwright driver does. */
class ParkingDriver implements ApplyDriver {
  readonly name = 'playwright' as const;
  async apply(_args: ApplyRunArgs): Promise<never> {
    throw new ApplyBlocked(
      'The greenhouse application form has 1 question that must not be answered automatically.',
      [],
      [
        {
          question: 'Are you willing to relocate?',
          answer: 'Yes, anywhere in the US',
          options: [
            { value: 'sometimes', label: 'Sometimes' },
            { value: 'never', label: 'Never' },
          ],
        },
      ],
    );
  }
  async dispose(): Promise<void> {}
}

describe('needs_human carries the real options', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, applyDriverFactory: () => new ParkingDriver() });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  it('parks with the options on the payload, then resolve-human writes the picks back', async () => {
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire', externalId: 'nh-1', canonicalUrl: 'https://example.com/nh-1',
      company: 'Options Co', title: 'Engineer', location: null, remoteType: 'remote', descriptionMd: 'desc',
    });
    const now = new Date().toISOString();
    const appRow = world.ctx.db
      .insert(applications)
      .values({
        jobId: job.id,
        status: 'ready_for_review',
        gate: 'review',
        approvedAt: now,
        answersJson: JSON.stringify({ 'Are you willing to relocate?': 'Yes, anywhere in the US' }),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const task = world.ctx.queue.enqueue('apply', { payload: { applicationId: appRow.id } });
    await world.runner.drain();

    const parked = world.ctx.queue.get(task.id)!;
    expect(parked.state).toBe('needs_human');
    const payload = JSON.parse(parked.payloadJson) as {
      applicationId: number;
      choices: { question: string; options: { value: string; label: string }[] }[];
    };
    expect(payload.applicationId).toBe(appRow.id);
    expect(payload.choices).toHaveLength(1);
    expect(payload.choices[0]!.options.map((o) => o.label)).toEqual(['Sometimes', 'Never']);

    // The user clicks an option → resolve with that answer.
    await request(app)
      .post(`/api/queue/tasks/${task.id}/resolve-human`)
      .send({ answers: { 'Are you willing to relocate?': 'never' } })
      .expect(200);

    expect(world.ctx.queue.get(task.id)!.state).toBe('pending');
    const updated = world.ctx.db.select().from(applications).where(eq(applications.id, appRow.id)).get()!;
    const answers = JSON.parse(updated.answersJson!) as Record<string, unknown>;
    expect(answers['Are you willing to relocate?']).toBe('never');
    expect(isNeedsUserAnswer(answers['Are you willing to relocate?'] as never)).toBe(false);
    const audit = JSON.parse(updated.auditJson) as { action: string }[];
    expect(audit.some((a) => a.action === 'answers.resolved_by_user')).toBe(true);
  });

  it('resolve-human without answers still just resumes the task', async () => {
    const t = world.ctx.queue.enqueue('score', { payload: {} });
    world.ctx.queue.needsHuman(t.id, 'do the thing');
    await request(app).post(`/api/queue/tasks/${t.id}/resolve-human`).send({}).expect(200);
    expect(world.ctx.queue.get(t.id)!.state).toBe('pending');
  });
});
