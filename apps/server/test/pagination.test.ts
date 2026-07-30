// Pagination contract for GET /api/applications and GET /api/emails:
// { total, <rows> } shape, limit/offset slicing, and filter interplay.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applications, emails, jobs } from '../src/db/schema';
import { makeApp, makeWorld, type TestWorld } from './helpers';

describe('pagination', () => {
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    world = makeWorld({ simulate: true });
    app = makeApp(world);
  });
  afterEach(() => world.cleanup());

  function seedApplications(n: number): void {
    const now = new Date();
    for (let i = 0; i < n; i += 1) {
      const job = world.ctx.db
        .insert(jobs)
        .values({
          source: 'freehire',
          company: i % 2 === 0 ? `EvenCorp ${i}` : `OddCorp ${i}`,
          title: 'Engineer',
          firstSeen: now.toISOString(),
          status: i < 2 ? 'ready_for_review' : 'applied',
          dedupeKey: `pg-${i}`,
        })
        .returning()
        .get();
      world.ctx.db
        .insert(applications)
        .values({
          jobId: job.id,
          status: i < 2 ? 'ready_for_review' : 'applied',
          gate: 'review',
          createdAt: now.toISOString(),
          // Distinct updatedAt so ordering (desc) is deterministic: newest = highest i.
          updatedAt: new Date(now.getTime() + i * 1000).toISOString(),
        })
        .run();
    }
  }

  it('applications: total + slicing + filters compose', async () => {
    seedApplications(7);

    const page1 = await request(app).get('/api/applications?limit=3').expect(200);
    expect(page1.body.total).toBe(7);
    expect(page1.body.applications.length).toBe(3);

    const page3 = await request(app).get('/api/applications?limit=3&offset=6').expect(200);
    expect(page3.body.total).toBe(7);
    expect(page3.body.applications.length).toBe(1);

    // Ordered by updatedAt desc → offset walks backwards in seed order.
    const first = page1.body.applications[0];
    const all = await request(app).get('/api/applications?limit=500').expect(200);
    expect(all.body.applications[0].id).toBe(first.id);
    expect(all.body.applications.length).toBe(7);

    // Filter interplay: total reflects the filtered set, not the table.
    const ready = await request(app).get('/api/applications?status=ready_for_review&limit=1').expect(200);
    expect(ready.body.total).toBe(2);
    expect(ready.body.applications.length).toBe(1);
    expect(ready.body.applications[0].status).toBe('ready_for_review');

    const q = await request(app).get('/api/applications?q=EvenCorp&limit=2').expect(200);
    expect(q.body.total).toBe(4); // i = 0,2,4,6
    expect(q.body.applications.length).toBe(2);
    for (const a of q.body.applications) expect(a.job.company).toContain('EvenCorp');

    // Bad params rejected.
    await request(app).get('/api/applications?limit=0').expect(400);
    await request(app).get('/api/applications?offset=-1').expect(400);
  });

  it('emails: total + slicing + direction filter compose (newest first)', async () => {
    for (let i = 0; i < 5; i += 1) {
      world.ctx.db
        .insert(emails)
        .values({
          threadKey: `t-${i}`,
          direction: i < 3 ? 'inbound' : 'outbound',
          classification: i === 0 ? 'interview_invite' : 'other',
          subject: `Mail ${i}`,
          receivedAt: new Date().toISOString(),
        })
        .run();
    }

    const page = await request(app).get('/api/emails?limit=2&offset=2').expect(200);
    expect(page.body.total).toBe(5);
    expect(page.body.emails.length).toBe(2);
    // Newest first (desc id): offset 2 of [5,4,3,2,1] → subjects Mail 2, Mail 1.
    expect(page.body.emails[0].subject).toBe('Mail 2');
    expect(page.body.emails[1].subject).toBe('Mail 1');

    const inbound = await request(app).get('/api/emails?direction=inbound&limit=2').expect(200);
    expect(inbound.body.total).toBe(3);
    expect(inbound.body.emails.length).toBe(2);
    for (const e of inbound.body.emails) expect(e.direction).toBe('inbound');

    const classified = await request(app).get('/api/emails?classification=interview_invite').expect(200);
    expect(classified.body.total).toBe(1);
    expect(classified.body.emails[0].subject).toBe('Mail 0');

    await request(app).get('/api/emails?limit=nope').expect(400);
  });
});
