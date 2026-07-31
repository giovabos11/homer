// Standing answers + screening resolution (FR-9): precedence, the answers
// PATCH with saveStanding propagation, approve blocking, and backward compat
// with legacy "FLAGGED_FOR_USER" rows.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isNeedsUserAnswer, type NeedsUserAnswer } from '@shared/types';
import { applications, jobs } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { answersResolved, normalizeAnswers, resolveScreeningAnswers } from '../src/docs/screening';
import { STANDING_ANSWER_DEFAULTS } from '../src/docs/standing';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

describe('screening resolution precedence (standing > profile rule > flagged)', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  beforeEach(() => {
    repo = makeFakeRepo();
  });
  afterEach(() => repo.cleanup());

  it('falls back to the profile rule, then flags what neither layer covers', () => {
    const answers = resolveScreeningAnswers(repo.root, STANDING_ANSWER_DEFAULTS);
    // profile rule (08-application-forms.md defaults table)
    expect(answers['Are you authorized to work in the US?']).toBe('Yes, for any employer');
    expect(answers['Will you now or in the future require sponsorship?']).toBe('No');
    // flagged rows become structured markers, never a magic string
    const salary = answers['Salary expectations'];
    expect(isNeedsUserAnswer(salary)).toBe(true);
    expect((salary as NeedsUserAnswer).standingKey).toBe('salaryExpectation');
    expect((salary as NeedsUserAnswer).hint).toBeTruthy();
    expect(JSON.stringify(answers)).not.toContain('FLAGGED_FOR_USER');
    expect(answersResolved(answers)).toBe(false);
  });

  it('a standing answer outranks both the profile rule and the flag', () => {
    const answers = resolveScreeningAnswers(repo.root, {
      ...STANDING_ANSWER_DEFAULTS,
      salaryExpectation: 'Open, targeting market rate for the role',
      earliestStartDate: 'Two weeks from an offer',
      citizenshipStatus: 'Authorized to work in the US for any employer',
      securityClearance: 'None',
      willingToRelocate: 'No, Dallas only',
    });
    expect(answers['Salary expectations']).toBe('Open, targeting market rate for the role');
    expect(answers['Earliest start date']).toBe('Two weeks from an offer');
    // Standing beats the profile-rule row for the same question.
    expect(answers['Are you willing to relocate?']).toBe('No, Dallas only');
    // The combined clearance/citizenship row needs BOTH before it resolves.
    expect(isNeedsUserAnswer(answers['Security clearance / citizenship questions'])).toBe(false);
    expect(answersResolved(answers)).toBe(true);
  });

  it('a half-answered combined question stays flagged', () => {
    const answers = resolveScreeningAnswers(repo.root, {
      ...STANDING_ANSWER_DEFAULTS,
      securityClearance: 'None',
    });
    expect(isNeedsUserAnswer(answers['Security clearance / citizenship questions'])).toBe(true);
  });

  it('a numeric floor becomes a suggestion, never an auto-answer', () => {
    const answers = resolveScreeningAnswers(repo.root, { ...STANDING_ANSWER_DEFAULTS, salaryMinAcceptable: 80000 });
    const salary = answers['Salary expectations'] as NeedsUserAnswer;
    expect(isNeedsUserAnswer(salary)).toBe(true);
    expect(salary.suggestion).toContain('80,000');
  });

  it('reads legacy FLAGGED_FOR_USER rows as needs-user markers', () => {
    const legacy = normalizeAnswers({
      'Are you willing to relocate?': 'Yes, anywhere in the US',
      'Salary expectations': 'FLAGGED_FOR_USER',
      'Earliest start date': 'Flagged for the candidate',
    });
    expect(legacy['Are you willing to relocate?']).toBe('Yes, anywhere in the US');
    expect(isNeedsUserAnswer(legacy['Salary expectations'])).toBe(true);
    expect((legacy['Salary expectations'] as NeedsUserAnswer).standingKey).toBe('salaryExpectation');
    expect(isNeedsUserAnswer(legacy['Earliest start date'])).toBe(true);
    expect(answersResolved(legacy)).toBe(false);
  });
});

describe('standing-answer routes + editable review answers', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  let world: TestWorld;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: true, repoRoot: repo.root });
    app = makeApp(world);
  });
  afterEach(() => {
    world.cleanup();
    repo.cleanup();
  });

  function seedApplication(answers: Record<string, unknown>) {
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: 'sa-1',
      canonicalUrl: 'https://example.com/jobs/sa-1',
      company: 'Standing Co',
      title: 'Software Engineer',
      location: 'Dallas, TX',
      remoteType: 'remote',
      descriptionMd: 'desc',
      status: 'ready_for_review',
    });
    const now = new Date().toISOString();
    const row = world.ctx.db
      .insert(applications)
      .values({
        jobId: job.id,
        status: 'ready_for_review',
        gate: 'review',
        answersJson: JSON.stringify(answers),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return { job, row };
  }

  it('GET returns defaults and the critical keys still missing', async () => {
    const res = await request(app).get('/api/standing-answers').expect(200);
    expect(res.body.answers.eeoRace).toBe('Prefer not to say');
    expect(res.body.answers.salaryExpectation).toBe('');
    expect(res.body.missingCritical).toEqual(['salaryExpectation', 'earliestStartDate', 'citizenshipStatus']);
  });

  it('PUT patches partially, validates, and clears the missing list', async () => {
    await request(app).put('/api/standing-answers').send({ salaryExpectation: 'Open, market rate' }).expect(200);
    const res = await request(app)
      .put('/api/standing-answers')
      .send({ earliestStartDate: 'Immediately', citizenshipStatus: 'Authorized for any US employer', salaryMinAcceptable: 80000 })
      .expect(200);
    expect(res.body.answers.salaryExpectation).toBe('Open, market rate'); // earlier patch survives
    expect(res.body.answers.salaryMinAcceptable).toBe(80000);
    expect(res.body.missingCritical).toEqual([]);

    await request(app).put('/api/standing-answers').send({ requiresSponsorship: 'maybe' }).expect(400);
    await request(app).put('/api/standing-answers').send({ nonsense: true }).expect(400);
  });

  it('PATCH /answers edits an answer and saveStanding makes it permanent', async () => {
    const { row } = seedApplication({
      'Are you authorized to work in the US?': 'Yes, for any employer',
      'Salary expectations': 'FLAGGED_FOR_USER',
    });

    const res = await request(app)
      .patch(`/api/applications/${row.id}/answers`)
      .send({
        answers: { 'Salary expectations': 'Open, targeting market rate for the role' },
        saveStanding: ['Salary expectations'],
      })
      .expect(200);

    expect(res.body.unresolved).toEqual([]);
    expect(res.body.savedAsStanding).toEqual(['salaryExpectation']);
    expect(res.body.application.answers['Salary expectations']).toBe('Open, targeting market rate for the role');
    // …and it is now a standing answer, so the NEXT application resolves it.
    expect(world.ctx.standing.get().salaryExpectation).toBe('Open, targeting market rate for the role');
    const next = resolveScreeningAnswers(repo.root, world.ctx.standing.get());
    expect(next['Salary expectations']).toBe('Open, targeting market rate for the role');
  });

  it('editing without saveStanding leaves the standing store untouched', async () => {
    const { row } = seedApplication({ 'Salary expectations': 'FLAGGED_FOR_USER' });
    await request(app)
      .patch(`/api/applications/${row.id}/answers`)
      .send({ answers: { 'Salary expectations': '95000 for this one' } })
      .expect(200);
    expect(world.ctx.standing.get().salaryExpectation).toBe('');
  });

  it('approve is refused while an answer still needs the user, and allowed once filled', async () => {
    const { row } = seedApplication({ 'Salary expectations': 'FLAGGED_FOR_USER' });
    const blocked = await request(app).post(`/api/applications/${row.id}/approve`).expect(409);
    expect(blocked.body.error).toBe('answers_unresolved');

    await request(app)
      .patch(`/api/applications/${row.id}/answers`)
      .send({ answers: { 'Salary expectations': 'Open, market rate' } })
      .expect(200);
    const ok = await request(app).post(`/api/applications/${row.id}/approve`).expect(200);
    expect(ok.body.taskId).toBeGreaterThan(0);
    expect(world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!.approvedAt).not.toBeNull();
    expect(world.ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId)).get()).toBeTruthy();
  });
});
