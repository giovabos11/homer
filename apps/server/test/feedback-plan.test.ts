// Feedback worker (FR-26/FR-27): config-change intents → planChange with a
// settingsPatch applied only via /api/feedback/:id/apply-plan; retro lessons
// append inside the guarded block of 07-interview-prep.md. MockRunner only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { appendRetroLessons } from '../src/workers/feedback';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

describe('feedback worker + plan application', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;
  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  it('config-change intent → planChange with settingsPatch, applied only on approval', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('feedback analyst')
          ? {
              text: JSON.stringify({
                response: 'Switching to a hybrid gate at 80 keeps review for borderline fits.',
                planChange: { description: 'Set gateMode=hybrid with threshold 80', settingsPatch: { gateMode: 'hybrid', hybridThreshold: 80 } },
                retroLessons: [],
              }),
            }
          : { text: 'ok' },
    });
    const app = makeApp(world);

    const created = await request(app).post('/api/feedback').send({ kind: 'idea', text: 'Auto-submit anything scoring above 80' }).expect(201);
    await world.runner.drain();

    const list = await request(app).get('/api/feedback').expect(200);
    const entry = (list.body as { id: number; planChange: { description: string; applied: boolean } | null }[])
      .find((f) => f.id === created.body.id)!;
    expect(entry.planChange).toMatchObject({ applied: false });

    // Settings unchanged until approval.
    expect((await request(app).get('/api/settings')).body.gateMode).toBe('review');

    await request(app).post(`/api/feedback/${entry.id}/apply-plan`).expect(200);
    const settings = (await request(app).get('/api/settings')).body as { gateMode: string; hybridThreshold: number };
    expect(settings.gateMode).toBe('hybrid');
    expect(settings.hybridThreshold).toBe(80);

    // Double-apply is refused.
    await request(app).post(`/api/feedback/${entry.id}/apply-plan`).expect(409);
  });

  it('an invalid proposed settingsPatch is rejected at apply time (409), settings untouched', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('feedback analyst')
          ? { text: JSON.stringify({ response: 'ok', planChange: { description: 'bogus', settingsPatch: { bogusKey: true } }, retroLessons: [] }) }
          : { text: 'ok' },
    });
    const app = makeApp(world);
    const created = await request(app).post('/api/feedback').send({ kind: 'idea', text: 'do something impossible' }).expect(201);
    await world.runner.drain();
    const res = await request(app).post(`/api/feedback/${created.body.id}/apply-plan`).expect(409);
    expect(res.body.error).toBe('invalid_plan');
    expect((await request(app).get('/api/settings')).body.gateMode).toBe('review');
  });

  it('retro feedback appends lessons inside the guarded block of 07-interview-prep.md', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('feedback analyst')
          ? {
              text: JSON.stringify({
                response: 'Good retro. Lesson recorded.',
                planChange: null,
                retroLessons: ['Prepare a concrete system-design example before onsite rounds'],
              }),
            }
          : { text: 'ok' },
    });
    const app = makeApp(world);
    await request(app).post('/api/feedback').send({ kind: 'retro', text: 'Struggled with the system design round at TestCo' }).expect(201);
    await world.runner.drain();

    const file = path.join(repo.root, '.claude', 'skills', 'job-application-assistant', '07-interview-prep.md');
    const md = fs.readFileSync(file, 'utf8');
    expect(md).toContain('RETRO-LESSONS:BEGIN');
    expect(md).toContain('Prepare a concrete system-design example');
    expect(md).toContain('RETRO-LESSONS:END');
    expect(md).toContain('# Interview Preparation Guide'); // original content untouched
  });

  it('appendRetroLessons is append-only inside the guarded block', () => {
    repo = makeFakeRepo();
    expect(appendRetroLessons(repo.root, ['first lesson'])).toBe(true);
    expect(appendRetroLessons(repo.root, ['second lesson'])).toBe(true);
    const md = fs.readFileSync(path.join(repo.root, '.claude', 'skills', 'job-application-assistant', '07-interview-prep.md'), 'utf8');
    expect(md.indexOf('first lesson')).toBeLessThan(md.indexOf('second lesson'));
    expect(md.match(/RETRO-LESSONS:BEGIN/g)).toHaveLength(1); // one block, entries appended inside
  });
});
