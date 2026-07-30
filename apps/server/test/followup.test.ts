// Follow-up drafting (FR-10/FR-11): AgentRunner drafts in the archived
// letter's voice, 60–120 words, no dashes, max maxFollowups, always
// approval-gated in the outbox. MockRunner only.
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { applications, emails, followups } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const body80 =
  'Thank you for considering my application for the Software Engineer position. ' +
  'Since applying I have continued shipping production features across my platform, including billing and authentication work directly relevant to your stack. ' +
  'I remain very interested in the role and in contributing to your team. ' +
  'I would welcome a short conversation about how my experience fits your roadmap, and I am happy to share more detail whenever useful for your review process.';

function seedQuietApplication(world: TestWorld, daysAgo: number) {
  const { job } = upsertJob(world.ctx.db, {
    source: 'freehire',
    externalId: 'fu-1',
    canonicalUrl: 'https://example.com/fu-1',
    company: 'Quiet Co',
    title: 'Software Engineer',
    location: null,
    remoteType: 'remote',
    descriptionMd: 'desc',
    status: 'applied',
  });
  const submitted = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const app = world.ctx.db
    .insert(applications)
    .values({ jobId: job.id, status: 'applied', gate: 'review', submittedAt: submitted, approvedAt: submitted, createdAt: submitted, updatedAt: submitted })
    .returning()
    .get();
  return { job, app };
}

describe('followup worker', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;
  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  it('drafts an agent-written follow-up into the approval-gated outbox (word count + no dashes)', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('follow-up email')
          ? { text: JSON.stringify({ subject: 'Following up on my Software Engineer application', body: body80 }) }
          : { text: 'ok' },
    });
    const { app } = seedQuietApplication(world, 12); // past followupAfterDays (10)
    world.ctx.queue.enqueue('followup', { payload: { trigger: 'test' } });
    await world.runner.drain();

    const outbox = (await request(makeApp(world)).get('/api/outbox').expect(200)).body as {
      bodyMd: string; needsApproval: boolean; sentAt: string | null; applicationId: number;
    }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.applicationId).toBe(app.id);
    expect(outbox[0]!.needsApproval).toBe(true);
    expect(outbox[0]!.sentAt).toBeNull(); // never sends without approval
    const words = outbox[0]!.bodyMd.split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(60);
    expect(words).toBeLessThanOrEqual(120);
    expect(outbox[0]!.bodyMd).not.toMatch(/[—–]/);
    expect(outbox[0]!.bodyMd).not.toMatch(/\s-\s/);

    // Re-running while a draft is open adds nothing.
    world.ctx.queue.enqueue('followup', { payload: { trigger: 'again' } });
    await world.runner.drain();
    expect(world.ctx.db.select().from(emails).where(eq(emails.needsApproval, 1)).all()).toHaveLength(1);
  });

  it('an unusable agent draft falls back to the safe template (still approval-gated)', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) => (o.prompt.includes('follow-up email') ? { text: 'no json here' } : { text: 'ok' }),
    });
    const { app } = seedQuietApplication(world, 15);
    world.ctx.queue.enqueue('followup', { payload: {} });
    await world.runner.drain();
    const drafts = world.ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.applicationId, app.id), eq(emails.needsApproval, 1)))
      .all();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.bodyMd).toContain('I applied for the Software Engineer position');
  });

  it('honors maxFollowups: no third draft after two were drafted', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('follow-up email')
          ? { text: JSON.stringify({ subject: 'Following up', body: body80 }) }
          : { text: 'ok' },
    });
    const { app } = seedQuietApplication(world, 30);
    // Two follow-ups already drafted (the max), none awaiting approval.
    for (let i = 0; i < 2; i += 1) {
      world.ctx.db.insert(followups).values({ applicationId: app.id, dueAt: new Date().toISOString(), draftMd: 'x', status: 'drafted' }).run();
    }
    world.ctx.queue.enqueue('followup', { payload: {} });
    await world.runner.drain();
    expect(world.ctx.db.select().from(emails).where(eq(emails.applicationId, app.id)).all()).toHaveLength(0);
  });
});
