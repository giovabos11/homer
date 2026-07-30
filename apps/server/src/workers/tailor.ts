// Tailor worker (REAL — FR-9, PRD D3, §6.2).
//
//  - Drafter agent produces strict-JSON resume + cover-letter content grounded
//    ONLY in the profile files (no fabrication; upstream grounding audit). The
//    job description is passed as fenced untrusted data.
//  - Reviewer agent critiques the draft (grounding, style, targeting) and may
//    return a revised draft; the reviewer never adds new factual claims.
//  - Rendered through apps/server/templates/*.html → PDF via headless Chromium;
//    1-page limit enforced with pdf-lib page counts + relevance-weighted
//    trimming; ATS-verified via the pdf-parse text layer (name/email/phone
//    literal, ≥70% keyword survival).
//  - Cover letter obeys the 03-writing-style.md no-dashes rule (stripDashes is
//    a belt-and-suspenders pass after drafting).
//  - Artifacts land in data/artifacts/applications/<appId>/; the upstream-style
//    archive (documents/applications/<Company>_<Role>/ with job_posting.md and
//    an outcome.md skeleton) is refreshed as well.
//  - Then the submit gate (D1) decides: review → wait in ready_for_review;
//    auto / hybrid≥threshold → logged auto-approval + enqueue apply. A failed
//    ATS verification always forces review, regardless of gate.
//  - SIMULATE=1 keeps the placeholder-PDF path for dashboard demos.
import path from 'node:path';
import { z } from 'zod';
import { fenceUntrusted, readProfileSources, stripDashes, strictJsonFooter } from '../agent/prompts';
import { decideGate } from '../pipeline/gate';
import { readProfile } from '../api/core';
import {
  renderCoverLetterOnePage,
  renderResumeOnePage,
  tailorDraftSchema,
  type RenderIdentity,
  type TailorDraft,
} from '../docs/content';
import { verifyAtsPdf, type AtsVerifyResult } from '../docs/render';
import { writeApplicationArchive } from '../docs/archive';
import { screeningAnswers } from '../docs/screening';
import { addAudit, ensureApplication, getJob, sleep, updateApplication, updateJob, writePlaceholderPdf, type JobRow } from './helpers';
import type { Worker, WorkerArgs } from './registry';
import type { AppContext } from '../context';

const DRAFT_SCHEMA_DESCRIPTION = [
  '{ "resume": { "summary": string,',
  '    "skills": [{ "category": string, "items": string[] }],',
  '    "experience": [{ "company": string, "role": string, "dates": string, "location": string,',
  '                     "bullets": [{ "text": string, "relevance": number 0-100 }] }],',
  '    "projects": [{ "name": string, "dates": string, "bullets": [{ "text": string, "relevance": number }] }],',
  '    "education": [{ "school": string, "degree": string, "dates": string, "details": string[] }] },',
  '  "coverLetter": { "addressee": string, "paragraphs": string[] (3-5), "closing": string },',
  '  "keywords": string[] (posting keywords the resume text genuinely covers),',
  '  "flags": string[] (claims/questions only the candidate can answer — never invented) }',
].join('\n');

const reviewSchema = z.object({
  approved: z.boolean(),
  critique: z.string().default(''),
  revised: tailorDraftSchema.optional(),
});

function buildDrafterPrompt(ctx: AppContext, job: JobRow): string {
  const { profile, style, claudeMd } = readProfileSources(ctx.repoRoot);
  return [
    'You are the resume/cover-letter DRAFTER of a local job-application pipeline.',
    'Draft a tailored ONE-PAGE resume and ONE-PAGE cover letter for the candidate',
    'and the job posting below.',
    '',
    'HARD RULES:',
    '- Ground EVERY claim in the candidate profile below. Never invent skills,',
    '  employers, dates, numbers, or experience. If the posting asks for something',
    '  the profile does not support, list it in "flags" instead of claiming it.',
    '- Cover letter: NO em dashes, NO en dashes, NO hyphen-style asides. Use',
    '  commas, parentheses, semicolons, or separate sentences (style guide rule 1).',
    '- Assign each resume bullet a relevance score (0-100) for THIS posting; the',
    '  renderer trims lowest-relevance bullets to enforce the 1-page limit.',
    '- keywords: only terms that truthfully appear in your drafted resume content.',
    '- When mentioning agentic coding / AI tooling, reference Claude Code by name.',
    '',
    '## Candidate profile (ground truth)',
    profile || '(profile skill file missing)',
    '',
    '## Career context (CLAUDE.md excerpt)',
    claudeMd || '(none)',
    '',
    '## Writing style guide',
    style || '(none)',
    '',
    `## Target role: ${job.title} at ${job.company}`,
    `Location: ${job.location ?? 'unspecified'} · remote type: ${job.remoteType} · source: ${job.source}`,
    '',
    fenceUntrusted('JOB_POSTING', job.descriptionMd?.trim() || '(no description captured)'),
    strictJsonFooter(DRAFT_SCHEMA_DESCRIPTION),
  ].join('\n');
}

function buildReviewerPrompt(ctx: AppContext, job: JobRow, draft: TailorDraft): string {
  const { profile, style } = readProfileSources(ctx.repoRoot);
  return [
    'You are the REVIEWER of a drafter–reviewer resume pipeline. Audit the draft',
    'below against the candidate profile and the writing style guide:',
    '- Grounding: flag and remove any claim not supported by the profile.',
    '- Style: cover letter must contain no em/en dashes or hyphen asides, no',
    '  clichés, no generic buzzwords.',
    '- Targeting: the summary and top bullets must address this posting.',
    'Return the (possibly revised) draft. You may rewrite/reorder/delete content',
    'but NEVER add factual claims that are not in the profile.',
    '',
    '## Candidate profile (ground truth)',
    profile || '(missing)',
    '',
    '## Writing style guide',
    style || '(missing)',
    '',
    `## Target role: ${job.title} at ${job.company}`,
    fenceUntrusted('JOB_POSTING', job.descriptionMd?.trim() || '(no description captured)'),
    '',
    '## Draft under review',
    JSON.stringify(draft, null, 2),
    strictJsonFooter(`{ "approved": boolean, "critique": string, "revised": <same shape as the draft, optional> }`),
  ].join('\n');
}

/** Enforce the no-dashes ghostwriting rule on all cover-letter prose. */
function applyNoDashRule(draft: TailorDraft): TailorDraft {
  return {
    ...draft,
    coverLetter: {
      addressee: draft.coverLetter.addressee,
      paragraphs: draft.coverLetter.paragraphs.map((p) => stripDashes(p)),
      closing: stripDashes(draft.coverLetter.closing),
    },
  };
}

async function draftWithReview(ctx: AppContext, job: JobRow, appId: number): Promise<{ draft: TailorDraft; critique: string }> {
  const drafted = await ctx.runner.run({
    prompt: buildDrafterPrompt(ctx, job),
    cwd: ctx.repoRoot,
    timeoutMs: ctx.config.agent.defaultTimeoutMs,
  });
  const parsed = tailorDraftSchema.safeParse(drafted.structured);
  if (!parsed.success) {
    throw new Error(`Drafter returned unparseable content: ${parsed.error.issues[0]?.message ?? 'no JSON'}`);
  }
  let draft = parsed.data;

  // Reviewer critique pass. A malformed reviewer reply keeps the drafter output.
  let critique = '';
  try {
    const reviewed = await ctx.runner.run({
      prompt: buildReviewerPrompt(ctx, job, draft),
      cwd: ctx.repoRoot,
      timeoutMs: ctx.config.agent.defaultTimeoutMs,
    });
    const review = reviewSchema.safeParse(reviewed.structured);
    if (review.success) {
      critique = review.data.critique;
      if (review.data.revised) draft = review.data.revised;
    } else {
      critique = '(reviewer reply unparseable — drafter output kept)';
    }
  } catch (err) {
    critique = `(reviewer pass failed: ${err instanceof Error ? err.message : String(err)} — drafter output kept)`;
  }
  addAudit(ctx, appId, 'tailor.reviewed', { critique: critique.slice(0, 2000) });
  return { draft: applyNoDashRule(draft), critique };
}

function identityFor(ctx: AppContext): RenderIdentity {
  const p = readProfile(ctx);
  return {
    name: p.fullName || 'Candidate',
    email: p.email,
    phone: p.phone,
    location: p.location,
    links: p.links,
  };
}

export const tailorWorker: Worker = {
  type: 'tailor',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { jobId?: number };
    const job = payload.jobId != null ? getJob(ctx, payload.jobId) : null;
    if (!job) return;
    if (job.legitVerdict === 'scam') {
      updateJob(ctx, job.id, { status: 'quarantined' }, 'job.scored'); // emit: no application event follows
      return;
    }

    const settings = ctx.settings.get();
    const gate = decideGate(settings, { source: job.source, fitScore: job.fitScore, legitVerdict: job.legitVerdict as never });
    const app = ensureApplication(ctx, job.id, gate.mode);
    updateJob(ctx, job.id, { status: 'tailoring' });
    updateApplication(ctx, app.id, { status: 'tailoring' });
    addAudit(ctx, app.id, 'tailor.started', { gate: gate.mode });

    const dir = path.join(ctx.artifactsDir, 'applications', String(app.id));
    let resumePath: string | null = null;
    let coverPath: string | null = null;
    let answers: Record<string, string> | null = null;
    let archiveDir: string | null = null;
    let atsOk = true;

    if (ctx.simulate) {
      await sleep(400);
      resumePath = writePlaceholderPdf(path.join(dir, 'resume.pdf'), `Resume — ${job.company} ${job.title}`);
      coverPath = writePlaceholderPdf(path.join(dir, 'cover-letter.pdf'), `Cover letter — ${job.company}`);
      answers = {
        'Are you authorized to work in the US?': 'Yes',
        'Are you willing to relocate?': 'Yes',
        'Salary expectation': 'FLAGGED_FOR_USER',
      };
      archiveDir = path.join('applications', String(app.id));
    } else {
      const identity = identityFor(ctx);
      const { draft } = await draftWithReview(ctx, job, app.id);

      // Render + 1-page enforcement (relevance-weighted trim loop).
      resumePath = path.join(dir, 'resume.pdf');
      coverPath = path.join(dir, 'cover-letter.pdf');
      const resumeTrim = await renderResumeOnePage(ctx.renderer, identity, draft.resume, resumePath);
      const coverTrim = await renderCoverLetterOnePage(ctx.renderer, identity, draft.coverLetter, coverPath);
      addAudit(ctx, app.id, 'tailor.rendered', {
        resumePages: resumeTrim.pages,
        coverPages: coverTrim.pages,
        resumeBulletsDropped: resumeTrim.dropped,
        coverParagraphsDropped: coverTrim.dropped.length,
      });

      // ATS verification of the resume text layer.
      let ats: AtsVerifyResult;
      try {
        ats = await verifyAtsPdf(resumePath, {
          name: identity.name,
          email: identity.email,
          phone: identity.phone,
          keywords: draft.keywords,
        });
      } catch (err) {
        ats = {
          ok: false, namePresent: false, emailPresent: false, phonePresent: false,
          keywordCoverage: 0, missingKeywords: draft.keywords,
          problems: [`text-layer extraction failed: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
      atsOk = ats.ok;
      addAudit(ctx, app.id, 'tailor.ats_verified', {
        ok: ats.ok,
        keywordCoverage: Math.round(ats.keywordCoverage * 100) / 100,
        problems: ats.problems,
      });

      // Screening answers from 08-application-forms.md defaults (flagged rows stay flagged).
      answers = screeningAnswers(ctx.repoRoot);
      for (const flag of draft.flags) answers[`FLAG: ${flag.slice(0, 160)}`] = 'FLAGGED_FOR_USER';

      // Upstream-style archive (documents/applications/<company>_<role>/).
      archiveDir = writeApplicationArchive(ctx.repoRoot, {
        company: job.company,
        role: job.title,
        postingMd: job.descriptionMd,
        canonicalUrl: job.canonicalUrl,
        source: job.source,
        fitScore: job.fitScore,
        coverLetterMd: [draft.coverLetter.addressee, '', ...draft.coverLetter.paragraphs, '', draft.coverLetter.closing, '', identity.name].join('\n'),
        resumeMd: `# ${identity.name} — resume draft for ${job.title} at ${job.company}\n\n${draft.resume.summary}`,
        resumePdfPath: resumePath,
        coverLetterPdfPath: coverPath,
      });
    }

    // Job first: updateApplication emits application.updated with the job
    // fetched at emit time, so the job row must already be current.
    updateJob(ctx, job.id, { status: 'ready_for_review' });
    updateApplication(ctx, app.id, {
      status: 'ready_for_review',
      resumePath,
      coverLetterPath: coverPath,
      answersJson: answers ? JSON.stringify(answers) : null,
      archiveDir,
    });
    addAudit(ctx, app.id, 'tailor.finished', { simulated: ctx.simulate, gateReason: gate.reason, atsOk });

    // Gate decision (D1). A failed ATS check always forces human review.
    if (gate.autoSubmit && atsOk) {
      updateApplication(ctx, app.id, { approvedAt: new Date().toISOString() });
      addAudit(ctx, app.id, 'gate.auto_approved', { reason: gate.reason });
      ctx.queue.enqueue('apply', { payload: { applicationId: app.id } });
    } else {
      if (gate.autoSubmit && !atsOk) {
        addAudit(ctx, app.id, 'gate.forced_review', { reason: 'ATS verification failed — auto-submit suppressed' });
      }
      ctx.bus.emit({
        type: 'toast',
        level: 'info',
        message: `${job.company} — ${job.title} is ready for review`,
      });
    }
  },
};
