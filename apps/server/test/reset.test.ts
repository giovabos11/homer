import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeWorld, type TestWorld } from './helpers';
import { buildPreview, executeReset } from '../src/api/reset';
import { upsertJob } from '../src/sources/dedupe';

describe('danger reset (FR-28)', () => {
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    world = makeWorld();
    app = makeApp(world);
    upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: 'r1',
      canonicalUrl: 'https://example.com/r1',
      company: 'Reset Co',
      title: 'Engineer',
      location: null,
      remoteType: 'remote',
    });
    fs.writeFileSync(path.join(world.ctx.artifactsDir, 'demo.pdf'), 'pdf-bytes');
  });
  afterEach(() => world.cleanup());

  it('preview lists exactly what will be deleted without deleting anything', async () => {
    const res = await request(app)
      .post('/api/reset')
      .send({ preview: true, scopes: ['db', 'artifacts'] })
      .expect(200);
    const preview = res.body.preview as string[];
    expect(preview.some((l) => l.includes('wipe table jobs (1 row)'))).toBe(true);
    expect(preview.some((l) => l.includes('delete data/artifacts/demo.pdf'))).toBe(true);
    // Nothing actually deleted.
    expect(fs.existsSync(path.join(world.ctx.artifactsDir, 'demo.pdf'))).toBe(true);
    const jobs = await request(app).get('/api/jobs').expect(200);
    expect(jobs.body.total).toBe(1);
  });

  it('profile scope preview lists git-HEAD restores (no execution in tests)', () => {
    const preview = buildPreview(world.ctx, ['profile']);
    expect(preview.some((l) => l.includes('01-candidate-profile.md'))).toBe(true);
    expect(preview.some((l) => l.includes('git HEAD'))).toBe(true);
  });

  it('execute without the RESET confirmation is rejected', async () => {
    const res = await request(app).post('/api/reset').send({ scopes: ['db'], confirmation: 'reset' }).expect(400);
    expect(res.body.error).toBe('confirmation_required');
    const jobs = await request(app).get('/api/jobs').expect(200);
    expect(jobs.body.total).toBe(1);
  });

  it('execute with RESET wipes the requested scopes', async () => {
    await request(app).post('/api/reset').send({ scopes: ['db', 'artifacts'], confirmation: 'RESET' }).expect(200);
    const jobs = await request(app).get('/api/jobs').expect(200);
    expect(jobs.body.total).toBe(0);
    expect(fs.existsSync(path.join(world.ctx.artifactsDir, 'demo.pdf'))).toBe(false);
    // Budgets re-seeded so discovery keeps working.
    const queue = await request(app).get('/api/queue').expect(200);
    expect(Array.isArray(queue.body.budgets)).toBe(true);
  });

  it('rejects unknown scopes', async () => {
    await request(app).post('/api/reset').send({ scopes: ['everything'], confirmation: 'RESET' }).expect(400);
  });

  // Regression: DATA_TABLES is wiped parent-before-child (jobs before
  // applications, …), which used to trip "FOREIGN KEY constraint failed" the
  // moment child rows existed. The defer_foreign_keys fix must survive a fully
  // FK-linked graph: job → application → email + followup, schedule_event → prep_task.
  it('db reset wipes FK-linked rows across all tables without a constraint failure', () => {
    const sq = world.ctx.handle.sqlite;
    const now = new Date().toISOString();
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: 'fk1',
      canonicalUrl: 'https://example.com/fk1',
      company: 'Cascade Co',
      title: 'Backend Engineer',
      location: null,
      remoteType: 'remote',
    });
    const appId = Number(
      sq.prepare(
        `INSERT INTO applications (job_id, status, gate, created_at, updated_at) VALUES (?, 'tailoring', 'review', ?, ?)`,
      ).run(job.id, now, now).lastInsertRowid,
    );
    sq.prepare(
      `INSERT INTO emails (thread_key, direction, classification, application_id, subject) VALUES ('t-fk1', 'inbound', 'other', ?, 'Re: your application')`,
    ).run(appId);
    sq.prepare(`INSERT INTO followups (application_id, due_at) VALUES (?, ?)`).run(appId, now);
    const eventId = Number(
      sq.prepare(
        `INSERT INTO schedule_events (type, application_id, title, starts_at) VALUES ('interview', ?, 'Tech screen', ?)`,
      ).run(appId, now).lastInsertRowid,
    );
    sq.prepare(`INSERT INTO prep_tasks (event_id, text) VALUES (?, 'Review system design notes')`).run(eventId);

    expect(() => executeReset(world.ctx, ['db'])).not.toThrow();

    for (const table of ['jobs', 'applications', 'emails', 'followups', 'schedule_events', 'prep_tasks']) {
      const { n } = sq.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      expect(n, `${table} should be empty after reset`).toBe(0);
    }
  });
});
