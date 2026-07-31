// Advisories vs questions (the review-modal fix), contextual salary prefill,
// and case-insensitive standing-answer validation.
//
// The bug this file guards: drafter/reviewer notes were written into
// applications.answers_json as { status: 'needs_user' } markers keyed "FLAG: …",
// so every application arrived with a pile of unanswerable "questions" that
// locked Approve and suppressed auto-submit.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { isNeedsUserAnswer, type NeedsUserAnswer } from '@shared/types';
import { applications, jobs } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import {
  classifyAdvisory,
  isAdvisoryQuestion,
  migrateApplicationAdvisories,
  parseAdvisories,
  salaryFloorAdvisory,
  toAdvisory,
} from '../src/docs/advisories';
import {
  answersResolved,
  defaultsFromAnswers,
  normalizeAnswers,
  postedRangePhrase,
  resolveScreeningAnswers,
  unresolvedQuestions,
} from '../src/docs/screening';
import { STANDING_ANSWER_DEFAULTS, canonicalizeStandingValue, normalizeYesNo } from '../src/docs/standing';
import { refreshStandingResolvedAnswers } from '../src/docs/answer-refresh';
import { FakeRenderer } from './fake-renderer';
import { makeApp, makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const FLAG_KEY =
  'FLAG: Posting lists MongoDB as a target database; candidate profile shows NoSQL via Firebase and Supabase but no direct MongoDB experience';
const CATCH_ALL = 'Skills, tools, or experience not in the profile';

const marker = (question: string): NeedsUserAnswer => ({
  status: 'needs_user',
  question,
  hint: 'The drafter could not ground this in your profile.',
});

describe('advisories are notes, not questions', () => {
  it('recognizes advisory keys and strips the FLAG prefix', () => {
    expect(isAdvisoryQuestion(FLAG_KEY)).toBe(true);
    expect(isAdvisoryQuestion(CATCH_ALL)).toBe(true);
    expect(isAdvisoryQuestion('Salary expectations')).toBe(false);
    expect(isAdvisoryQuestion('Are you willing to relocate?')).toBe(false);
    expect(toAdvisory(FLAG_KEY).text.startsWith('FLAG:')).toBe(false);
  });

  it('classifies notes by topic so the modal can group them', () => {
    expect(classifyAdvisory('Posting names CockroachDB; no CockroachDB experience in the profile')).toBe('gap');
    expect(classifyAdvisory('Posting does not list a salary or equity range')).toBe('compensation');
    expect(classifyAdvisory('Job requires in-person work in the San Francisco Bay Area')).toBe('location');
    expect(classifyAdvisory("No independently verified information about the company's products")).toBe('unverified');
    expect(classifyAdvisory('Posting prefers demonstrated automated testing; the profile documents CI/CD only')).toBe('gap');
    expect(classifyAdvisory('Posting mentions microservices and infrastructure-as-code as pluses')).toBe('gap');
    expect(classifyAdvisory('Something entirely unrelated to any known topic here')).toBe('other');
  });

  it('never blocks approval or auto-submit, even if a FLAG key survives in answers', () => {
    const answers = normalizeAnswers({
      'Are you willing to relocate?': 'Yes, anywhere in the US',
      'Salary expectations': 'Open',
      [FLAG_KEY]: marker(FLAG_KEY),
      [CATCH_ALL]: marker(CATCH_ALL),
    });
    expect(unresolvedQuestions(answers)).toEqual([]);
    expect(answersResolved(answers)).toBe(true);
    // …and the apply driver never sees a note as a fillable field.
    expect(defaultsFromAnswers(answers).map((d) => d.question)).toEqual([
      'Are you willing to relocate?',
      'Salary expectations',
    ]);
  });

  it('still blocks on a REAL unanswered question', () => {
    const answers = normalizeAnswers({
      'Salary expectations': marker('Salary expectations'),
      [FLAG_KEY]: marker(FLAG_KEY),
    });
    expect(unresolvedQuestions(answers)).toEqual(['Salary expectations']);
    expect(answersResolved(answers)).toBe(false);
  });

  it('parses stored advisories defensively (bad JSON, bare strings, missing kind)', () => {
    expect(parseAdvisories(null)).toEqual([]);
    expect(parseAdvisories('not json')).toEqual([]);
    expect(parseAdvisories('{"nope":1}')).toEqual([]);
    expect(parseAdvisories('["Posting wants Rust; not in the profile"]')[0]!.kind).toBe('gap');
    expect(parseAdvisories('[{"text":"Role is onsite in San Francisco"}]')[0]!.kind).toBe('location');
  });
});

describe('the catch-all row is a policy statement, not a question', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  beforeEach(() => {
    repo = makeFakeRepo();
  });
  afterEach(() => repo.cleanup());

  it('never enters the answers map', () => {
    const answers = resolveScreeningAnswers(repo.root, STANDING_ANSWER_DEFAULTS);
    expect(Object.keys(answers)).not.toContain(CATCH_ALL);
    // The real questions from the same table are still there.
    expect(answers['Are you authorized to work in the US?']).toBe('Yes, for any employer');
  });
});

describe('boot repair moves drafting notes out of answers', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld({ simulate: true });
  });
  afterEach(() => world.cleanup());

  function seed(answers: Record<string, unknown>, advisoriesJson = '[]') {
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: `adv-${Math.random()}`,
      canonicalUrl: 'https://example.com/jobs/adv',
      company: 'Advisory Co',
      title: 'Software Engineer',
      location: 'Dallas, TX',
      remoteType: 'remote',
      descriptionMd: 'desc',
      status: 'ready_for_review',
    });
    const now = new Date().toISOString();
    return world.ctx.db
      .insert(applications)
      .values({
        jobId: job.id,
        status: 'ready_for_review',
        gate: 'review',
        answersJson: JSON.stringify(answers),
        advisoriesJson,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  it('moves FLAG keys and the catch-all, leaves real answers untouched, and is idempotent', () => {
    const row = seed({
      'Are you willing to relocate?': 'Yes, anywhere in the US',
      'Salary expectations': 'Open',
      'Earliest start date': marker('Earliest start date'),
      [CATCH_ALL]: marker(CATCH_ALL),
      [FLAG_KEY]: marker(FLAG_KEY),
      'FLAG: Posting does not list a salary or equity range': marker('FLAG: …'),
    });

    const first = migrateApplicationAdvisories(world.ctx.db);
    expect(first.changed).toBe(1);
    expect(first.movedEntries).toBe(3);
    expect(first.perApplication[0]).toMatchObject({ id: row.id, before: 4, after: 1 });

    const after = world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!;
    const answers = JSON.parse(after.answersJson!) as Record<string, unknown>;
    expect(Object.keys(answers)).toEqual([
      'Are you willing to relocate?',
      'Salary expectations',
      'Earliest start date',
    ]);
    expect(answers['Are you willing to relocate?']).toBe('Yes, anywhere in the US');
    expect(isNeedsUserAnswer(answers['Earliest start date'] as never)).toBe(true); // a REAL question survives

    const advisories = parseAdvisories(after.advisoriesJson);
    expect(advisories).toHaveLength(2);
    expect(advisories.some((a) => a.text.includes('MongoDB') && a.kind === 'gap')).toBe(true);
    expect(advisories.some((a) => a.kind === 'compensation')).toBe(true);
    expect(JSON.stringify(advisories)).not.toContain('FLAG:');

    // Idempotent: a second (and third) pass finds nothing left to move.
    const second = migrateApplicationAdvisories(world.ctx.db);
    expect(second.changed).toBe(0);
    const third = migrateApplicationAdvisories(world.ctx.db);
    expect(third.changed).toBe(0);
    const stable = world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!;
    expect(parseAdvisories(stable.advisoriesJson)).toHaveLength(2);
  });

  it('keeps a note the user actually typed against a FLAG row', () => {
    const row = seed({ [FLAG_KEY]: 'I did a MongoDB tutorial last year' });
    migrateApplicationAdvisories(world.ctx.db);
    const after = world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!;
    expect(parseAdvisories(after.advisoriesJson)[0]!.text).toContain('your note: I did a MongoDB tutorial');
  });

  it('keeps a real answer typed into the catch-all row', () => {
    const row = seed({ [CATCH_ALL]: 'Ask me about Kubernetes' });
    migrateApplicationAdvisories(world.ctx.db);
    const after = world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!;
    expect((JSON.parse(after.answersJson!) as Record<string, unknown>)[CATCH_ALL]).toBe('Ask me about Kubernetes');
  });

  it('does not touch an application with no notes', () => {
    seed({ 'Salary expectations': 'Open' });
    expect(migrateApplicationAdvisories(world.ctx.db).changed).toBe(0);
  });
});

describe('contextual salary prefill', () => {
  let repo: ReturnType<typeof makeFakeRepo>;
  beforeEach(() => {
    repo = makeFakeRepo();
  });
  afterEach(() => repo.cleanup());

  const posted = { salaryMin: 130000, salaryMax: 165000, salaryCurrency: 'USD', salaryPredicted: false };

  it('references the posted range instead of a bare "Open"', () => {
    const answers = resolveScreeningAnswers(
      repo.root,
      { ...STANDING_ANSWER_DEFAULTS, salaryExpectation: 'Open' },
      posted,
    );
    expect(answers['Salary expectations']).toBe('Aligned with the posted range ($130,000-$165,000)');
  });

  it('falls back to the standing value when the posting has no range', () => {
    const answers = resolveScreeningAnswers(
      repo.root,
      { ...STANDING_ANSWER_DEFAULTS, salaryExpectation: 'Open' },
      { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPredicted: false },
    );
    expect(answers['Salary expectations']).toBe('Open');
  });

  it("a figure the user set always wins over the posting's range", () => {
    const answers = resolveScreeningAnswers(
      repo.root,
      { ...STANDING_ANSWER_DEFAULTS, salaryExpectation: '$120,000 base' },
      posted,
    );
    expect(answers['Salary expectations']).toBe('$120,000 base');
  });

  it('never quotes a predicted range, and handles one-sided ranges', () => {
    expect(postedRangePhrase({ ...posted, salaryPredicted: true })).toBeNull();
    expect(postedRangePhrase({ ...posted, salaryMax: null })).toBe('Aligned with the posted range ($130,000+)');
    expect(postedRangePhrase({ ...posted, salaryMin: null })).toBe('Aligned with the posted range (up to $165,000)');
    expect(postedRangePhrase(null)).toBeNull();
  });

  it('offers the posted range as a one-click suggestion when salary is unanswered', () => {
    const answers = resolveScreeningAnswers(repo.root, STANDING_ANSWER_DEFAULTS, posted);
    const salary = answers['Salary expectations'] as NeedsUserAnswer;
    expect(isNeedsUserAnswer(salary)).toBe(true); // unset stays unset: nothing is invented
    expect(salary.suggestion).toBe('Aligned with the posted range ($130,000-$165,000)');
  });

  it('keeps the numeric-floor suggestion when there is no posted range', () => {
    const answers = resolveScreeningAnswers(repo.root, { ...STANDING_ANSWER_DEFAULTS, salaryMinAcceptable: 80000 });
    expect((answers['Salary expectations'] as NeedsUserAnswer).suggestion).toContain('80,000');
  });

  it('turns a below-floor posted range into an advisory, never a block', () => {
    const standing = { ...STANDING_ANSWER_DEFAULTS, salaryMinAcceptable: 80000 };
    const note = salaryFloorAdvisory({ salaryMin: 60000, salaryMax: 90000, salaryCurrency: 'USD', salaryPredicted: 0 }, standing);
    expect(note!.kind).toBe('compensation');
    expect(note!.text).toContain('$60,000');
    expect(note!.text).toContain('$80,000');
    // At or above the floor, and for predicted ranges, there is nothing to say.
    expect(salaryFloorAdvisory({ salaryMin: 90000, salaryMax: 120000, salaryCurrency: 'USD', salaryPredicted: 0 }, standing)).toBeNull();
    expect(salaryFloorAdvisory({ salaryMin: 60000, salaryMax: 90000, salaryCurrency: 'USD', salaryPredicted: 1 }, standing)).toBeNull();
    expect(salaryFloorAdvisory({ salaryMin: 60000, salaryMax: null, salaryCurrency: 'USD', salaryPredicted: 0 }, STANDING_ANSWER_DEFAULTS)).toBeNull();
  });
});

describe('standing-answer validation is case-insensitive and normalizing', () => {
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

  it('normalizeYesNo accepts every casing and phrasing', () => {
    for (const v of ['No', 'no', 'NO', 'nope'.slice(0, 2), 'None', 'false', 'No, I do not']) {
      expect(normalizeYesNo(v)).toBe('no');
    }
    for (const v of ['Yes', 'yes', 'YES', 'Y', 'true', 'Yes, I will']) expect(normalizeYesNo(v)).toBe('yes');
    expect(normalizeYesNo('')).toBe('');
    expect(normalizeYesNo('maybe')).toBeNull();
  });

  it('PUT accepts "No" for requiresSponsorship (the exact value that used to 400)', async () => {
    const res = await request(app).put('/api/standing-answers').send({ requiresSponsorship: 'No' }).expect(200);
    expect(res.body.answers.requiresSponsorship).toBe('no');
    await request(app).put('/api/standing-answers').send({ requiresSponsorship: 'YES' }).expect(200);
    expect(world.ctx.standing.get().requiresSponsorship).toBe('yes');
    // Genuinely invalid values are still refused.
    await request(app).put('/api/standing-answers').send({ requiresSponsorship: 'maybe' }).expect(400);
  });

  it('snaps typed enum-ish values onto their canonical option', async () => {
    const res = await request(app)
      .put('/api/standing-answers')
      .send({ willingToRelocate: 'yes, anywhere in the us', eeoGender: 'MALE', noticePeriod: '2 WEEKS' })
      .expect(200);
    expect(res.body.answers.willingToRelocate).toBe('Yes, anywhere in the US');
    expect(res.body.answers.eeoGender).toBe('Male');
    expect(res.body.answers.noticePeriod).toBe('2 weeks');
  });

  it('keeps free text that is not on any option list', () => {
    expect(canonicalizeStandingValue('securityClearance', 'Interim Secret, in progress')).toBe(
      'Interim Secret, in progress',
    );
    expect(canonicalizeStandingValue('salaryExpectation', '  Open  ')).toBe('Open');
    expect(canonicalizeStandingValue('eeoVeteran', 'Not a veteran')).toBe('Not a veteran');
  });
});

describe('tailor + gate end to end: notes never hold an application back', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;

  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  const draft = {
    resume: {
      summary: 'Full-stack developer building production TypeScript and React applications.',
      skills: [{ category: 'Primary', items: ['TypeScript', 'React'] }],
      experience: [
        {
          company: 'Rigaly',
          role: 'Founder',
          dates: '2025–',
          location: 'Remote',
          bullets: [{ text: 'Shipped a production TypeScript platform.', relevance: 95 }],
        },
      ],
      projects: [],
      education: [{ school: 'SMU', degree: 'B.S. Computer Science', dates: '2022–2025', details: [] }],
    },
    coverLetter: {
      addressee: 'Dear Hiring Manager,',
      paragraphs: ['I am applying.', 'I shipped production software.', 'I would love to contribute.'],
      closing: 'Thank you for your consideration.',
    },
    keywords: ['TypeScript', 'React'],
    flags: [
      'Posting lists MongoDB as a target database; the profile has no direct MongoDB experience. Not claimed.',
      "No independently verified information about the company's products was available during drafting.",
      'Role is onsite in San Francisco; confirm relocation timeline.',
    ],
  };

  const script = (o: { prompt: string }) => {
    if (o.prompt.includes('DRAFTER')) return { text: JSON.stringify(draft) };
    if (o.prompt.includes('REVIEWER')) return { text: JSON.stringify({ approved: true, critique: 'ok' }) };
    return { text: 'ok' };
  };

  it('three drafter notes + every question answered → auto-submitted with the notes preserved', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, renderer: new FakeRenderer(6000), script });
    world.ctx.standing.patch({
      salaryExpectation: 'Open',
      earliestStartDate: 'One week from offer',
      citizenshipStatus: 'Authorized to work in the US for any employer',
      securityClearance: 'None',
    });
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: 'adv-e2e',
      canonicalUrl: 'https://example.com/jobs/adv-e2e',
      company: 'Notes Co',
      title: 'Software Engineer',
      location: 'Dallas, TX',
      remoteType: 'remote',
      descriptionMd: 'We need TypeScript and React. '.repeat(5),
      status: 'screened',
    });
    world.ctx.db
      .update(jobs)
      .set({ fitScore: 82, legitVerdict: 'legit', salaryMin: 130000, salaryMax: 165000, salaryCurrency: 'USD' })
      .where(eq(jobs.id, job.id))
      .run();
    world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });
    await world.runner.tick();

    const row = world.ctx.db.select().from(applications).where(eq(applications.jobId, job.id)).get()!;
    const answers = normalizeAnswers(JSON.parse(row.answersJson!) as Record<string, unknown>);
    expect(unresolvedQuestions(answers)).toEqual([]);
    expect(Object.keys(answers).some((k) => k.startsWith('FLAG:'))).toBe(false);
    // Salary answered against the posting's own published range.
    expect(answers['Salary expectations']).toBe('Aligned with the posted range ($130,000-$165,000)');
    // The notes are all kept, grouped by topic.
    const advisories = parseAdvisories(row.advisoriesJson);
    expect(advisories).toHaveLength(3);
    expect(advisories.map((a) => a.kind).sort()).toEqual(['gap', 'location', 'unverified']);
    // …and nothing about them held the application back.
    expect(row.approvedAt).not.toBeNull();
    expect(row.autoSubmitted).toBe(1);
  });
});

describe('legacy FLAGGED_FOR_USER rows repair the same way', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld({ simulate: true });
  });
  afterEach(() => world.cleanup());

  it('treats the raw sentinel as unanswered, not as a note the user typed', () => {
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: 'legacy-adv',
      canonicalUrl: 'https://example.com/jobs/legacy',
      company: 'Legacy Co',
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
        answersJson: JSON.stringify({
          'Are you willing to relocate?': 'Yes, anywhere in the US',
          [CATCH_ALL]: 'FLAGGED_FOR_USER',
          [FLAG_KEY]: 'FLAGGED_FOR_USER',
        }),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    const res = migrateApplicationAdvisories(world.ctx.db);
    expect(res.perApplication[0]).toMatchObject({ id: row.id, before: 2, after: 0 });
    const after = world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!;
    const advisories = parseAdvisories(after.advisoriesJson);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.text).not.toContain('FLAGGED_FOR_USER');
    expect(Object.keys(JSON.parse(after.answersJson!) as object)).toEqual(['Are you willing to relocate?']);
    expect(answersResolved(normalizeAnswers(JSON.parse(after.answersJson!) as Record<string, unknown>))).toBe(true);
  });
});

describe('standing answers are applied retroactively', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld({ simulate: true });
  });
  afterEach(() => world.cleanup());

  function seed(status: string, answers: Record<string, unknown>, salary?: { min: number; max: number }) {
    const { job } = upsertJob(world.ctx.db, {
      source: 'freehire',
      externalId: `refresh-${Math.random()}`,
      canonicalUrl: 'https://example.com/jobs/refresh',
      company: 'Refresh Co',
      title: 'Software Engineer',
      location: 'Dallas, TX',
      remoteType: 'remote',
      descriptionMd: 'desc',
      status: 'ready_for_review',
    });
    if (salary) {
      world.ctx.db
        .update(jobs)
        .set({ salaryMin: salary.min, salaryMax: salary.max, salaryCurrency: 'USD' })
        .where(eq(jobs.id, job.id))
        .run();
    }
    const now = new Date().toISOString();
    return world.ctx.db
      .insert(applications)
      .values({
        jobId: job.id,
        status,
        gate: 'review',
        answersJson: JSON.stringify(answers),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  it('fills questions the user has since answered, and quotes the posted range', () => {
    world.ctx.standing.patch({
      salaryExpectation: 'Open',
      earliestStartDate: 'One week from offer',
      citizenshipStatus: 'Authorized to work in the US for any employer',
      securityClearance: 'None',
    });
    const row = seed(
      'ready_for_review',
      {
        'Salary expectations': marker('Salary expectations'),
        'Earliest start date': 'FLAGGED_FOR_USER',
        'Security clearance / citizenship questions': marker('Security clearance / citizenship questions'),
        'Are you willing to relocate?': 'Yes, anywhere in the US',
        'Will you now or in the future require sponsorship?': 'no',
      },
      { min: 130000, max: 165000 },
    );

    const res = refreshStandingResolvedAnswers(world.ctx.db, world.ctx.standing.get());
    expect(res.changed).toBe(1);
    expect(res.resolved).toBe(4); // 3 unanswered + the lowercase sponsorship value

    const after = world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!;
    const answers = normalizeAnswers(JSON.parse(after.answersJson!) as Record<string, unknown>);
    expect(answersResolved(answers)).toBe(true);
    expect(answers['Salary expectations']).toBe('Aligned with the posted range ($130,000-$165,000)');
    expect(answers['Earliest start date']).toBe('One week from offer');
    expect(answers['Security clearance / citizenship questions']).toBe(
      'None; Authorized to work in the US for any employer',
    );
    expect(answers['Are you willing to relocate?']).toBe('Yes, anywhere in the US'); // untouched
    expect(answers['Will you now or in the future require sponsorship?']).toBe('No'); // reads as an answer, not a token
    // Idempotent, and it never approves anything.
    expect(refreshStandingResolvedAnswers(world.ctx.db, world.ctx.standing.get()).changed).toBe(0);
    expect(after.approvedAt).toBeNull();
  });

  it('leaves a question alone when the standing answer is still unset', () => {
    const row = seed('ready_for_review', { 'Salary expectations': marker('Salary expectations') });
    expect(refreshStandingResolvedAnswers(world.ctx.db, world.ctx.standing.get()).changed).toBe(0);
    const after = world.ctx.db.select().from(applications).where(eq(applications.id, row.id)).get()!;
    expect(answersResolved(normalizeAnswers(JSON.parse(after.answersJson!) as Record<string, unknown>))).toBe(false);
  });

  it('does not rewrite an application that is already submitted', () => {
    world.ctx.standing.patch({ salaryExpectation: 'Open' });
    seed('applied', { 'Salary expectations': marker('Salary expectations') });
    expect(refreshStandingResolvedAnswers(world.ctx.db, world.ctx.standing.get()).changed).toBe(0);
  });
});
