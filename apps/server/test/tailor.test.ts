// Tailor pipeline tests (FR-9/D3): relevance-weighted 1-page trim loop with a
// mocked renderer, and the full real tailor worker (drafter → reviewer →
// render → ATS verify → archive → gate) with MockRunner only.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  dropLowestRelevanceBullet,
  renderCoverLetterOnePage,
  renderResumeOnePage,
  resumeContentSchema,
  type RenderIdentity,
  type ResumeContent,
} from '../src/docs/content';
import { applications, jobs, taskQueue } from '../src/db/schema';
import { upsertJob } from '../src/sources/dedupe';
import { FakeRenderer } from './fake-renderer';
import { makeFakeRepo, makeWorld, type TestWorld } from './helpers';

const identity: RenderIdentity = {
  name: 'Test Candidate',
  email: 'test.candidate@example.com',
  phone: '+1 555-010-0000',
  location: 'Dallas, TX 75231, USA',
  links: [{ label: 'GitHub', url: 'https://github.com/testcandidate' }],
};

function bigResume(): ResumeContent {
  const bullet = (rel: number) => ({
    text: `Bullet with relevance ${rel}: ${'shipped measurable results across the platform stack. '.repeat(3)}`,
    relevance: rel,
  });
  return resumeContentSchema.parse({
    summary: 'Full-stack developer with production TypeScript, React, and Node.js experience.',
    skills: [{ category: 'Primary', items: ['TypeScript', 'React', 'Node.js', 'SQL'] }],
    experience: [
      { company: 'Rigaly', role: 'Founder', dates: '2025–', location: 'Remote', bullets: [bullet(90), bullet(20), bullet(70)] },
      { company: 'VIBE', role: 'Developer', dates: '2025', location: 'Dallas', bullets: [bullet(80), bullet(10), bullet(60)] },
    ],
    projects: [{ name: 'Search Engine', dates: '2022', bullets: [bullet(30), bullet(5)] }],
    education: [{ school: 'SMU', degree: 'B.S. Computer Science', dates: '2022–2025', details: ['GPA 3.98'] }],
  });
}

describe('1-page enforcement (relevance-weighted trim)', () => {
  it('dropLowestRelevanceBullet removes the globally lowest bullet, keeping ≥1 per experience entry', () => {
    const content = bigResume();
    expect(dropLowestRelevanceBullet(content)).toContain('relevance 5'); // project bullet, lowest overall
    expect(dropLowestRelevanceBullet(content)).toContain('relevance 10');
    expect(dropLowestRelevanceBullet(content)).toContain('relevance 20');
    // Experience entries never drop below one bullet each.
    const exp = bigResume();
    for (let i = 0; i < 20; i += 1) dropLowestRelevanceBullet(exp);
    expect(exp.experience.every((e) => e.bullets.length >= 1)).toBe(true);
  });

  it('renderResumeOnePage trims lowest-relevance bullets until the PDF is one page', async () => {
    const renderer = new FakeRenderer(900); // force multi-page at first
    const out = path.join(process.env.TEMP ?? '.', `ajs-trim-${Date.now()}.pdf`);
    const result = await renderResumeOnePage(renderer, identity, bigResume(), out);
    expect(result.pages).toBe(1);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped[0]).toContain('relevance 5'); // lowest relevance goes first
    expect(renderer.renders).toBeGreaterThan(1); // measured, trimmed, re-measured
    fs.rmSync(out, { force: true });
  });

  it('renderCoverLetterOnePage drops middle paragraphs, never the opening or closing', async () => {
    const renderer = new FakeRenderer(700);
    const out = path.join(process.env.TEMP ?? '.', `ajs-cover-${Date.now()}.pdf`);
    const paragraphs = [
      `OPENING ${'intro sentence. '.repeat(10)}`,
      `MIDDLE-1 ${'evidence sentence. '.repeat(10)}`,
      `MIDDLE-2 ${'more evidence. '.repeat(10)}`,
      `FINAL ${'forward-looking close. '.repeat(10)}`,
    ];
    const result = await renderCoverLetterOnePage(renderer, identity, {
      addressee: 'Dear Hiring Manager,',
      paragraphs,
      closing: 'I look forward to hearing from you.',
    }, out);
    expect(result.pages).toBe(1);
    expect(result.content.paragraphs[0]).toContain('OPENING');
    expect(result.content.paragraphs[result.content.paragraphs.length - 1]).toContain('FINAL');
    expect(result.dropped.every((d) => d.includes('MIDDLE'))).toBe(true);
    fs.rmSync(out, { force: true });
  });
});

// ---- full real tailor worker (MockRunner-scripted drafter/reviewer) ----

const draftJson = {
  resume: {
    summary: 'Full-stack developer building production TypeScript, React, and Node.js applications end to end.',
    skills: [{ category: 'Primary', items: ['TypeScript', 'React', 'Node.js', 'SQL'] }],
    experience: [
      {
        company: 'Rigaly',
        role: 'Founder & Full Stack Developer',
        dates: 'Aug 2025 – Present',
        location: 'Remote',
        bullets: [
          { text: 'Built a production loyalty platform with TypeScript and React serving 500+ customers.', relevance: 95 },
          { text: 'Deployed Node.js services with automated CI/CD.', relevance: 85 },
        ],
      },
    ],
    projects: [],
    education: [{ school: 'Southern Methodist University', degree: 'B.S. Computer Science', dates: '2022–2025', details: ['GPA 3.98, Magna Cum Laude'] }],
  },
  coverLetter: {
    addressee: 'Dear Hiring Manager,',
    paragraphs: [
      'I am writing to apply for the Software Engineer role at Fixture Co — a company I admire.',
      'At Rigaly I built a production platform - end to end - with TypeScript, React, and Node.js.',
      'I would welcome the chance to bring that ownership to your team.',
    ],
    closing: 'Thank you for your consideration.',
  },
  keywords: ['TypeScript', 'React', 'Node.js'],
  flags: ['Posting asks about Kubernetes experience (not in profile)'],
};

function scriptFor(draft: unknown) {
  return (o: { prompt: string }) => {
    if (o.prompt.includes('DRAFTER')) return { text: JSON.stringify(draft) };
    if (o.prompt.includes('REVIEWER')) return { text: JSON.stringify({ approved: true, critique: 'grounded and targeted' }) };
    return { text: 'ok' };
  };
}

describe('tailor worker (real path, MockRunner)', () => {
  let world: TestWorld;
  let repo: ReturnType<typeof makeFakeRepo>;

  afterEach(() => {
    world?.cleanup();
    repo?.cleanup();
  });

  function seedJob(w: TestWorld) {
    const { job } = upsertJob(w.ctx.db, {
      source: 'freehire',
      externalId: 'fx-1',
      canonicalUrl: 'https://example.com/jobs/fx-1',
      company: 'Fixture Co',
      title: 'Software Engineer',
      location: 'Dallas, TX',
      remoteType: 'hybrid',
      descriptionMd: 'We need TypeScript, React, and Node.js. '.repeat(5),
      status: 'screened',
    });
    w.ctx.db.update(jobs).set({ fitScore: 82, legitVerdict: 'legit' }).where(eq(jobs.id, job.id)).run();
    return job;
  }

  it('drafts, reviews, renders 1-page PDFs, ATS-verifies, archives, and waits at the review gate', async () => {
    repo = makeFakeRepo();
    world = makeWorld({ simulate: false, repoRoot: repo.root, renderer: new FakeRenderer(6000), script: scriptFor(draftJson) });
    const job = seedJob(world);
    world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });
    await world.runner.drain();

    const app = world.ctx.db.select().from(applications).where(eq(applications.jobId, job.id)).get()!;
    expect(app.status).toBe('ready_for_review');
    expect(app.approvedAt).toBeNull(); // review gate (default) waits for the user
    expect(fs.existsSync(app.resumePath!)).toBe(true);
    expect(fs.existsSync(app.coverLetterPath!)).toBe(true);

    // Screening answers came from the 08-application-forms defaults table.
    const answers = JSON.parse(app.answersJson!) as Record<string, unknown>;
    expect(answers['Are you authorized to work in the US?']).toBe('Yes, for any employer');
    // Unanswerable rows are structured needs-user markers, never a magic string.
    expect(answers['Salary expectations']).toMatchObject({ status: 'needs_user', standingKey: 'salaryExpectation' });
    expect(answers['Earliest start date']).toMatchObject({ status: 'needs_user', standingKey: 'earliestStartDate' });
    expect(JSON.stringify(answers)).not.toContain('FLAGGED_FOR_USER');
    // Drafter flags are NOTES, not questions: they land in advisories, never in
    // the answers map, and never as something the user has to "answer".
    expect(Object.keys(answers).some((k) => k.startsWith('FLAG:'))).toBe(false);
    const advisories = JSON.parse(app.advisoriesJson) as { kind: string; text: string }[];
    const kubernetes = advisories.find((a) => a.text.includes('Kubernetes'));
    expect(kubernetes).toBeTruthy();
    expect(kubernetes!.text.startsWith('FLAG:')).toBe(false);
    expect(kubernetes!.kind).toBe('gap');

    // Upstream-style archive with outcome skeleton; cover letter obeys the no-dashes rule.
    const archive = path.join(repo.root, app.archiveDir!);
    expect(fs.existsSync(path.join(archive, 'job_posting.md'))).toBe(true);
    expect(fs.existsSync(path.join(archive, 'outcome.md'))).toBe(true);
    expect(fs.existsSync(path.join(archive, 'resume.pdf'))).toBe(true);
    const letter = fs.readFileSync(path.join(archive, 'cover_letter.md'), 'utf8');
    expect(letter).not.toMatch(/[—–]/);
    expect(letter).not.toMatch(/\s-\s/);

    // ATS verification passed and is in the audit trail.
    const audit = JSON.parse(app.auditJson) as { action: string; ok?: boolean }[];
    const ats = audit.find((a) => a.action === 'tailor.ats_verified');
    expect(ats?.ok).toBe(true);
  });

  it('a failed ATS keyword check suppresses auto-submit even under gate=auto', async () => {
    repo = makeFakeRepo();
    const badDraft = { ...draftJson, keywords: ['Kubernetes', 'Terraform', 'Golang'] }; // absent from content
    world = makeWorld({ simulate: false, repoRoot: repo.root, renderer: new FakeRenderer(6000), script: scriptFor(badDraft) });
    world.ctx.settings.patch({ gateMode: 'auto' });
    const job = seedJob(world);
    world.ctx.queue.enqueue('tailor', { payload: { jobId: job.id } });
    await world.runner.drain();

    const app = world.ctx.db.select().from(applications).where(eq(applications.jobId, job.id)).get()!;
    expect(app.status).toBe('ready_for_review');
    expect(app.approvedAt).toBeNull(); // ATS failure forces review despite auto gate
    const applyTasks = world.ctx.db.select().from(taskQueue).where(eq(taskQueue.type, 'apply')).all();
    expect(applyTasks.length).toBe(0);
    const audit = JSON.parse(app.auditJson) as { action: string; ok?: boolean; reason?: string }[];
    expect(audit.find((a) => a.action === 'tailor.ats_verified')?.ok).toBe(false);
    expect(audit.some((a) => a.action === 'gate.forced_review')).toBe(true);
  });
});
