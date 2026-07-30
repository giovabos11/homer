// Prep-guide worker (FR-13/FR-21/FR-23): agent-built guide, prep-task
// explosion with skill tags, prepGuidePath, and the skills rollup. MockRunner only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { prepTasks, scheduleEvents, skillsProgress } from '../src/db/schema';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const guideJson = {
  guideMd: [
    '# Interview prep: Technical interview — TestCo',
    '',
    '## Company research',
    'TestCo builds developer tooling (mock research).',
    '',
    '## Technical topics',
    '### React — [docs](https://react.dev), [patterns](https://example.com/react-patterns)',
    '',
    '## Likely questions + STAR mappings',
    '- "Tell me about a project you own" → STAR: platform launch',
    '',
    '## Questions to ask',
    '- What does success look like in 6 months?',
    '',
    '## Logistics',
    'Interview: 2026-08-10T14:00:00Z',
  ].join('\n'),
  tasks: [
    { skillTag: 'react', text: 'Review React rendering + hooks' },
    { skillTag: 'system-design', text: 'Practice one system design question' },
    { skillTag: 'behavioral', text: 'Rehearse two STAR stories' },
    { skillTag: 'company-research', text: 'Read recent TestCo news' },
  ],
};

describe('prep_guide worker (real path, MockRunner)', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;
  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  it('explodes the checklist into skill-tagged prep tasks, saves the guide, and rolls up skills', async () => {
    repo = makeFakeRepo();
    world = makeWorld({
      simulate: false,
      repoRoot: repo.root,
      script: (o) =>
        o.prompt.includes('interview-prep engine') ? { text: JSON.stringify(guideJson) } : { text: 'ok' },
    });
    const app = makeApp(world);

    // Creating an interview event auto-enqueues the prep guide (FR-13).
    const created = await request(app)
      .post('/api/schedule')
      .send({ type: 'interview', title: 'Technical interview — TestCo', startsAt: '2026-08-10T14:00:00Z', company: 'TestCo' })
      .expect(201);
    const eventId = created.body.id as number;
    await world.runner.drain();

    // Guide saved + attached to the event.
    const event = world.ctx.db.select().from(scheduleEvents).where(eq(scheduleEvents.id, eventId)).get()!;
    expect(event.prepGuidePath).toBeTruthy();
    const guideAbs = path.join(world.ctx.artifactsDir, event.prepGuidePath!);
    expect(fs.existsSync(guideAbs)).toBe(true);
    const guide = fs.readFileSync(guideAbs, 'utf8');
    expect(guide).toContain('2026-08-10T14:00:00Z'); // actual interview time in logistics
    expect(guide).toContain('STAR');

    // Checklist exploded with skill tags.
    const tasksRes = await request(app).get(`/api/prep-tasks?eventId=${eventId}`).expect(200);
    expect(tasksRes.body).toHaveLength(4);
    const tags = (tasksRes.body as { skillTag: string }[]).map((t) => t.skillTag).sort();
    expect(tags).toEqual(['behavioral', 'company-research', 'react', 'system-design']);

    // Skills rollup starts at 0 done.
    let skills = (await request(app).get('/api/skills-progress').expect(200)).body as {
      skill: string; totalTasks: number; doneTasks: number;
    }[];
    expect(skills.find((s) => s.skill === 'react')).toMatchObject({ totalTasks: 1, doneTasks: 0 });

    // Checking a task off updates the rollup + skills_progress level.
    const reactTask = (tasksRes.body as { id: number; skillTag: string }[]).find((t) => t.skillTag === 'react')!;
    await request(app).patch(`/api/prep-tasks/${reactTask.id}`).send({ done: true }).expect(200);
    skills = (await request(app).get('/api/skills-progress').expect(200)).body as typeof skills;
    expect(skills.find((s) => s.skill === 'react')).toMatchObject({ totalTasks: 1, doneTasks: 1 });
    const level = world.ctx.db.select().from(skillsProgress).where(eq(skillsProgress.skill, 'react')).get()!;
    expect(level.level).toBe(100);

    // Regeneration replaces the event's tasks instead of duplicating them.
    await request(app).post(`/api/schedule/${eventId}/prep`).expect(200);
    await world.runner.drain();
    expect(world.ctx.db.select().from(prepTasks).where(eq(prepTasks.eventId, eventId)).all()).toHaveLength(4);
  });
});
