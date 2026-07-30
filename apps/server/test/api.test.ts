import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, makeWorld, type TestWorld } from './helpers';

describe('API smoke (contract)', () => {
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    world = makeWorld({ simulate: true });
    app = makeApp(world);
  });
  afterEach(() => world.cleanup());

  it('GET /api/health', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe('string');
  });

  it('jobs CRUD: create manual, list with filters, get, skip, validation errors', async () => {
    const created = await request(app)
      .post('/api/jobs')
      .send({ company: 'Manual Co', title: 'Backend Dev', status: 'applied', salaryMax: 140000 })
      .expect(201);
    expect(created.body.managed).toBe('manual');
    expect(created.body.status).toBe('applied');

    await request(app).post('/api/jobs').send({ company: 'NoTitle Co' }).expect(400);

    const list = await request(app).get('/api/jobs?status=applied&q=Manual').expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.jobs[0].company).toBe('Manual Co');

    const empty = await request(app).get('/api/jobs?status=offer').expect(200);
    expect(empty.body.total).toBe(0);

    const byId = await request(app).get(`/api/jobs/${created.body.id}`).expect(200);
    expect(byId.body.id).toBe(created.body.id);
    await request(app).get('/api/jobs/99999').expect(404);

    const skipped = await request(app).post(`/api/jobs/${created.body.id}/skip`).expect(200);
    expect(skipped.body.status).toBe('skipped');
  });

  it('GET /api/jobs/top ranks by salary with fitWeighted toggle', async () => {
    await request(app).post('/api/jobs').send({ company: 'LowPay', title: 'Dev', salaryMax: 90000 }).expect(201);
    await request(app).post('/api/jobs').send({ company: 'HighPay', title: 'Dev', salaryMax: 200000 }).expect(201);
    const top = await request(app).get('/api/jobs/top?limit=5').expect(200);
    expect(top.body[0].company).toBe('HighPay');
    const weighted = await request(app).get('/api/jobs/top?fitWeighted=true').expect(200);
    expect(weighted.body.length).toBe(2);
  });

  it('settings: GET defaults, PATCH validated partial, reject unknown/invalid', async () => {
    const before = await request(app).get('/api/settings').expect(200);
    expect(before.body.gateMode).toBe('review');
    expect(before.body.hybridThreshold).toBe(75);

    const patched = await request(app)
      .patch('/api/settings')
      .send({ gateMode: 'hybrid', hybridThreshold: 80 })
      .expect(200);
    expect(patched.body.gateMode).toBe('hybrid');
    expect(patched.body.hybridThreshold).toBe(80);
    // Persisted.
    const after = await request(app).get('/api/settings').expect(200);
    expect(after.body.gateMode).toBe('hybrid');

    await request(app).patch('/api/settings').send({ gateMode: 'yolo' }).expect(400);
    await request(app).patch('/api/settings').send({ nonsenseKey: 1 }).expect(400);
  });

  it('queue: search enqueues discover; pause/resume roundtrip', async () => {
    const search = await request(app).post('/api/search').send({ keywords: 'react native' }).expect(200);
    expect(typeof search.body.searchId).toBe('string');

    const queue = await request(app).get('/api/queue').expect(200);
    expect(queue.body.paused).toBe(false);
    expect(queue.body.tasks.some((t: { type: string }) => t.type === 'discover')).toBe(true);
    expect(Array.isArray(queue.body.budgets)).toBe(true);

    const paused = await request(app).post('/api/queue/pause').expect(200);
    expect(paused.body.paused).toBe(true);
    const resumed = await request(app).post('/api/queue/resume').expect(200);
    expect(resumed.body.paused).toBe(false);
  });

  it('full SIMULATE pipeline: apply → ready_for_review → approve → applied (+ follow-up scheduled)', async () => {
    const job = await request(app)
      .post('/api/jobs')
      .send({ company: 'Pipeline Co', title: 'Full-Stack Engineer', canonicalUrl: 'https://example.com/p1' })
      .expect(201);

    await request(app).post(`/api/jobs/${job.body.id}/apply`).expect(200);
    await world.runner.drain();

    const apps = await request(app).get('/api/applications').expect(200);
    expect(apps.body.total).toBe(1);
    expect(apps.body.applications[0].status).toBe('ready_for_review');
    expect(apps.body.applications[0].resumePath).toBeTruthy();

    const artifacts = await request(app)
      .get(`/api/applications/${apps.body.applications[0].id}/artifacts`)
      .expect(200);
    expect(artifacts.body.resumeUrl).toMatch(/^\/files\//);

    await request(app).post(`/api/applications/${apps.body.applications[0].id}/approve`).expect(200);
    await world.runner.drain();

    const after = await request(app).get('/api/applications').expect(200);
    expect(after.body.applications[0].status).toBe('applied');
    expect(after.body.applications[0].submittedAt).toBeTruthy();

    const schedule = await request(app).get('/api/schedule').expect(200);
    expect(schedule.body.some((e: { type: string }) => e.type === 'followup_due')).toBe(true);
  });

  it('credentials: store → masked list → reveal → delete', async () => {
    await request(app)
      .post('/api/credentials')
      .send({ site: 'greenhouse.io', username: 'gio', password: 's3cret!', hasCaptcha: true })
      .expect(201);
    const list = await request(app).get('/api/credentials').expect(200);
    expect(list.body[0].maskedPassword).toBe('••••••••');
    expect(list.body[0]).not.toHaveProperty('password');

    const revealed = await request(app).post('/api/credentials/greenhouse.io/reveal').expect(200);
    expect(revealed.body.password).toBe('s3cret!');

    await request(app).delete('/api/credentials/greenhouse.io').expect(200);
    await request(app).post('/api/credentials/greenhouse.io/reveal').expect(404);
  });

  it('outbox approval flow enforces the approval gate', async () => {
    // No draft yet → approving a random id 404s.
    await request(app).post('/api/outbox/999/approve').expect(404);
  });

  it('ask returns a requestId and streams via the bus', async () => {
    const deltas: string[] = [];
    const unsub = world.ctx.bus.subscribe((e) => {
      if (e.type === 'ask.delta') deltas.push(e.delta);
    });
    const res = await request(app).post('/api/ask').send({ prompt: 'Say hello' }).expect(200);
    expect(typeof res.body.requestId).toBe('string');
    await world.runner.drain();
    unsub();
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('GET /api/events is an SSE stream with snapshot on connect', async () => {
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;

    const { headers, body } = await new Promise<{ headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/events`, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buf += chunk;
            if (buf.includes('queue.snapshot') && buf.includes('connection.updated')) {
              res.destroy();
              resolve({ headers: res.headers, body: buf });
            }
          });
          res.on('error', () => resolve({ headers: res.headers, body: buf }));
        });
        req.on('error', reject);
        setTimeout(() => reject(new Error('SSE snapshot timeout')), 8000).unref();
      },
    );

    expect(headers['content-type']).toContain('text/event-stream');
    expect(body).toContain('event: queue.snapshot');
    expect(body).toContain('event: connection.updated');
    server.close();
  });

  it('unknown API routes return the contract error shape', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error).toBe('not_found');
  });
});
