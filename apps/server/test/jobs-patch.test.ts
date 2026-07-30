// PATCH /api/jobs/:id (dashboard request): pre-application transitions only.
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { jobs } from '../src/db/schema';
import { makeApp, makeWorld } from './helpers';

const world = makeWorld();
const app = makeApp(world);
afterAll(() => world.cleanup());

async function createJob(company: string) {
  const res = await request(app).post('/api/jobs').send({ company, title: 'Software Engineer' }).expect(201);
  return res.body as { id: number; status: string };
}

describe('PATCH /api/jobs/:id', () => {
  it('allows the four pre-application transitions', async () => {
    const job = await createJob('Patch Co');
    for (const status of ['screened', 'skipped', 'quarantined', 'discovered']) {
      const res = await request(app).patch(`/api/jobs/${job.id}`).send({ status }).expect(200);
      expect(res.body.status).toBe(status);
    }
  });

  it('rejects application-lifecycle target statuses with 400', async () => {
    const job = await createJob('Patch Co 2');
    for (const status of ['tailoring', 'ready_for_review', 'applied', 'interview', 'offer', 'hired', 'rejected']) {
      const res = await request(app).patch(`/api/jobs/${job.id}`).send({ status }).expect(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.detail).toContain('/api/applications');
    }
    // Untouched by the rejected attempts.
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, job.id)).get()!.status).toBe('discovered');
  });

  it('409s when the job already has an application in flight', async () => {
    const job = await createJob('Patch Co 3');
    world.ctx.db.update(jobs).set({ status: 'applied' }).where(eq(jobs.id, job.id)).run();
    const res = await request(app).patch(`/api/jobs/${job.id}`).send({ status: 'skipped' }).expect(409);
    expect(res.body.error).toBe('invalid_state');
  });

  it('404s for unknown jobs and validates the body', async () => {
    await request(app).patch('/api/jobs/999999').send({ status: 'skipped' }).expect(404);
    await request(app).patch('/api/jobs/1').send({}).expect(400);
  });
});
