// Apply worker (REAL — FR-9, FR-25, FR-30, PRD D5, §6.2, §11).
//
//  - Requires an approval record (user click or logged auto-approval per the
//    gate) before anything touches a browser; submission itself only happens
//    because that approval exists.
//  - APPLY CHANNEL FIRST. The stored URL is classified before any browser work:
//    an aggregator redirect is followed to the employer (or handed back as
//    needs_manual when it dead-ends on the aggregator), and an email-only
//    posting produces an approval-gated Outbox draft instead of a browser run.
//    Only `ats_form` reaches the driver.
//  - LIVENESS BEFORE FORM INTERACTION. A dead posting is detected up front and
//    is never reported as something else. When the URL belongs to a queryable
//    ATS board the same role is re-resolved on the live board and the apply
//    continues against the fresh URL; ambiguity or a miss marks the job
//    `expired` and fails the task with a plain "Posting no longer available",
//    with the board's current openings recorded for the user.
//  - Driver selection: settings.applyDriver, with automation-hostile sources
//    (LinkedIn) always routed through ChromeApplyDriver, which parks the task
//    for the human-paced claude-in-chrome flow.
//  - Captcha / login wall / flagged screening questions → the driver throws
//    ApplyBlocked carrying an explicit ParkReason; this worker records the audit
//    trail and re-throws as NeedsHuman so the dashboard alerts and the browser
//    stays open (FR-25).
//  - Every run stores screenshots + filled fields + answers in audit_json;
//    success moves the kanban to Applied (confetti), schedules the T+N
//    follow-up, and appends to the archive's outcome.md.
//  - ATS account creation uses the profile email + a vault-generated password
//    (handled inside the Playwright driver via the credential store below).
//  - SIMULATE=1 keeps the fake-success path for dashboard demos; it never
//    claims a real submission happened.
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Advisory, ApplyChannel, JobStatus, ParkReason } from '@shared/types';
import { toEmail, toScheduleEvent } from '../db/serialize';
import { credentialsMeta, emails, followups, scheduleEvents } from '../db/schema';
import { readProfile } from '../api/core';
import { strictJsonFooter } from '../agent/prompts';
import { appendOutcomeNote } from '../docs/archive';
import { normalizeAnswers } from '../docs/screening';
import { mergeAdvisories, parseAdvisories } from '../docs/advisories';
import { ApplyBlocked, type ApplyCredentialStore, type ApplyProfile } from '../apply/driver';
import { classifyApplyChannel, extractContactEmail } from '../apply/channel';
import {
  checkPostingLiveness,
  followRedirectChain,
  postingUrl,
  reresolvePosting,
  type BoardPosting,
} from '../apply/liveness';
import { addAudit, getApplication, getJob, sleep, updateApplication, updateJob, type ApplicationRow, type JobRow } from './helpers';
import { NeedsHuman, TerminalFailure, type Worker, type WorkerArgs } from './registry';
import type { AppContext } from '../context';

/** Vault-backed credential store for the driver (FR-30, PRD D8). */
export function vaultCredentialStore(ctx: AppContext): ApplyCredentialStore {
  return {
    async lookup(site: string) {
      const row = ctx.db.select().from(credentialsMeta).where(eq(credentialsMeta.site, site)).get();
      if (!row) return null;
      const password = await ctx.vault.get(row.vaultRef);
      if (password == null) return null;
      return { username: row.username, password };
    },
    async save(site: string, username: string, password: string) {
      const vaultRef = `cred:${site}`;
      await ctx.vault.set(vaultRef, password);
      const now = new Date().toISOString();
      ctx.db
        .insert(credentialsMeta)
        .values({ site, username, vaultRef, hasCaptcha: 0, notes: 'auto-registered by apply driver', createdAt: now })
        .onConflictDoUpdate({ target: credentialsMeta.site, set: { username, vaultRef } })
        .run();
    },
  };
}

function buildApplyProfile(ctx: AppContext, app: ApplicationRow): ApplyProfile {
  const p = readProfile(ctx);
  const parts = (p.fullName || 'Candidate').trim().split(/\s+/);
  const answers = normalizeAnswers(app.answersJson ? (JSON.parse(app.answersJson) as Record<string, unknown>) : {});
  let coverLetterText: string | undefined;
  if (app.archiveDir) {
    const md = path.join(ctx.repoRoot, app.archiveDir, 'cover_letter.md');
    try {
      if (fs.existsSync(md)) coverLetterText = fs.readFileSync(md, 'utf8');
    } catch {
      /* optional */
    }
  }
  return {
    fullName: p.fullName,
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
    email: p.email,
    phone: p.phone,
    location: p.location,
    links: p.links,
    resumePath: app.resumePath,
    coverLetterPath: app.coverLetterPath,
    coverLetterText,
    answers,
  };
}

/** Append an advisory to the application without duplicating it on a re-run. */
function addAdvisory(ctx: AppContext, app: ApplicationRow, advisory: Advisory): void {
  const current = parseAdvisories(app.advisoriesJson);
  const merged = mergeAdvisories(current, [advisory]);
  if (merged.length === current.length) return;
  updateApplication(ctx, app.id, { advisoriesJson: JSON.stringify(merged) });
}

/**
 * Move the card out of Ready for review into a state that tells the truth.
 * Job first: updateApplication emits application.updated with the job fetched
 * at emit time, so the job row must already carry the new status.
 */
function parkOutOfPipeline(
  ctx: AppContext,
  app: ApplicationRow,
  job: JobRow,
  status: Extract<JobStatus, 'expired' | 'needs_manual'>,
  advisory: Advisory,
  toast: string,
): void {
  updateJob(ctx, job.id, { status }, 'job.scored');
  updateApplication(ctx, app.id, { status });
  addAdvisory(ctx, getApplication(ctx, app.id) ?? app, advisory);
  ctx.bus.emit({ type: 'toast', level: 'warning', message: toast });
}

function openingsList(openings: BoardPosting[]): string {
  if (openings.length === 0) return 'that board currently lists no open postings';
  return `currently open there: ${openings.slice(0, 8).map((p) => p.title).join(' · ')}${openings.length > 8 ? ` (+${openings.length - 8} more)` : ''}`;
}

// ---------------------------------------------------------------------------
// Email channel — an approval-gated Outbox draft instead of a browser run
// ---------------------------------------------------------------------------

const emailDraftSchema = z.object({ subject: z.string().min(1), body: z.string().min(1) });

function fallbackApplicationEmail(job: JobRow, name: string): { subject: string; body: string } {
  return {
    subject: `Application: ${job.title}`,
    body: [
      `Hello ${job.company} team,`,
      '',
      `I am applying for the ${job.title} role you posted. My resume and cover letter are attached; ` +
        'both are tailored to this posting rather than generic. I would welcome the chance to talk about the work and how I can contribute.',
      '',
      'Thank you for your time.',
      '',
      name,
    ].join('\n'),
  };
}

async function draftApplicationEmail(
  ctx: AppContext,
  job: JobRow,
  app: ApplicationRow,
  name: string,
): Promise<{ subject: string; body: string }> {
  if (ctx.simulate) return fallbackApplicationEmail(job, name);
  let letterVoice = '';
  if (app.archiveDir) {
    const md = path.join(ctx.repoRoot, app.archiveDir, 'cover_letter.md');
    try {
      if (fs.existsSync(md)) letterVoice = fs.readFileSync(md, 'utf8').slice(0, 6000);
    } catch {
      /* optional */
    }
  }
  try {
    const result = await ctx.runner.run({
      prompt: [
        "Draft a short application email in the candidate's own voice (ghostwritten,",
        'first person). It is sent to a hiring contact who posted the role in a',
        'Hacker News "Who is hiring" thread or similar, where applying means writing',
        'to a person rather than filling a form.',
        '',
        'HARD RULES:',
        '- 90 to 160 words in the body.',
        '- No em dashes, no en dashes, no hyphen-style asides.',
        '- Only claims that appear in the cover letter below. Invent nothing.',
        '- Mention that the tailored resume and cover letter are attached.',
        '- No clichés, no "I am writing to express my interest".',
        '',
        `Role: ${job.title} at ${job.company}${job.location ? ` (${job.location})` : ''}.`,
        '',
        '## Voice reference — the cover letter drafted for this application',
        letterVoice || '(no archived letter — write plainly and specifically)',
        strictJsonFooter('{ "subject": string, "body": string }'),
      ].join('\n'),
      cwd: ctx.repoRoot,
      model: ctx.settings.get().modelEmail,
      timeoutMs: ctx.config.agent.defaultTimeoutMs,
    });
    const parsed = emailDraftSchema.safeParse(result.structured);
    if (!parsed.success) return fallbackApplicationEmail(job, name);
    return { subject: parsed.data.subject.trim(), body: parsed.data.body.trim() };
  } catch {
    return fallbackApplicationEmail(job, name);
  }
}

/**
 * Draft the application email into the Outbox, where it waits for the same
 * approval every outbound message needs (FR-11). Returns false when there is no
 * address to write to.
 */
async function applyByEmail(ctx: AppContext, app: ApplicationRow, job: JobRow): Promise<boolean> {
  const address = extractContactEmail(job.descriptionMd);
  if (!address) return false;

  const profile = readProfile(ctx);
  const threadKey = `application-app-${app.id}`;
  const existing = ctx.db.select().from(emails).where(eq(emails.threadKey, threadKey)).get();
  if (existing) {
    // Idempotent: a retry must not stack a second draft of the same application.
    addAudit(ctx, app.id, 'apply.email_draft_exists', { emailId: existing.id, to: address });
    ctx.bus.emit({ type: 'outbox.updated', email: toEmail(existing) });
    return true;
  }

  const draft = await draftApplicationEmail(ctx, job, app, profile.fullName || 'Candidate');
  const attachments = [app.resumePath, app.coverLetterPath].filter((p): p is string => !!p);
  const body = [
    `To: ${address}`,
    '',
    draft.body,
    '',
    attachments.length > 0
      ? `Attach before sending:\n${attachments.map((p) => `- ${p}`).join('\n')}`
      : 'No tailored PDFs were generated for this application.',
  ].join('\n');

  const row = ctx.db
    .insert(emails)
    .values({
      threadKey,
      direction: 'outbound',
      classification: 'other',
      applicationId: app.id,
      subject: draft.subject,
      summary: `Application email to ${address} for ${job.company} — awaiting your approval`,
      bodyMd: body,
      needsApproval: 1,
    })
    .returning()
    .get();
  ctx.bus.emit({ type: 'outbox.updated', email: toEmail(row) });
  addAudit(ctx, app.id, 'apply.email_drafted', { to: address, emailId: row.id, subject: draft.subject });
  addAdvisory(ctx, app, {
    kind: 'other',
    text:
      `This posting is applied to by email, not through a form. The application email to ${address} is drafted in the Outbox ` +
      'and will not be sent until you approve it.',
  });
  ctx.bus.emit({
    type: 'toast',
    level: 'info',
    message: `${job.company} applies by email — draft ready in the Outbox for your approval`,
  });
  return true;
}

// ---------------------------------------------------------------------------

export const applyWorker: Worker = {
  type: 'apply',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { applicationId?: number };
    const app = payload.applicationId != null ? getApplication(ctx, payload.applicationId) : null;
    if (!app) return;
    let job = getJob(ctx, app.jobId);
    if (!job) return;

    // Last line of defence against a double submission. Dedupe at the enqueue
    // sites keeps duplicates from ever being created; this catches the ones
    // that predate the guard (or a task requeued after the submission landed).
    // Checked BEFORE the approval record so it stays a clean no-op, not a
    // failure that retries forever.
    if (app.submittedAt) {
      addAudit(ctx, app.id, 'apply.skipped_already_submitted', { taskId: task.id, submittedAt: app.submittedAt });
      console.log(`[apply] task ${task.id}: application ${app.id} was already submitted — no-op`);
      return;
    }
    if (!app.approvedAt) {
      throw new Error(`Application ${app.id} has no approval record — the submit gate must run first`);
    }

    const settings = ctx.settings.get();
    const now = new Date();

    const recordSuccess = (audit: Record<string, unknown>) => {
      // Job first: updateApplication emits application.updated with the job
      // fetched at emit time, so the job row must already say 'applied'.
      updateJob(ctx, job!.id, { status: 'applied' });
      updateApplication(ctx, app.id, { status: 'applied', submittedAt: now.toISOString() });
      addAudit(ctx, app.id, 'apply.submitted', audit);
      // Schedule the follow-up checkpoint (FR-10/FR-12).
      const due = new Date(now.getTime() + settings.followupAfterDays * 86400000);
      ctx.db.insert(followups).values({ applicationId: app.id, dueAt: due.toISOString(), status: 'pending' }).run();
      const event = ctx.db
        .insert(scheduleEvents)
        .values({
          type: 'followup_due',
          applicationId: app.id,
          title: `Follow up: ${job!.company} — ${job!.title}`,
          startsAt: due.toISOString(),
          company: job!.company,
        })
        .returning()
        .get();
      ctx.bus.emit({ type: 'schedule.updated', event: toScheduleEvent(event) });
      ctx.bus.emit({
        type: 'toast',
        level: 'success',
        message: `Applied to ${job!.company} — ${job!.title}`,
        celebrate: true,
      });
      if (app.archiveDir) {
        appendOutcomeNote(ctx.repoRoot, app.archiveDir, `Application submitted via ${String(audit.driver ?? 'pipeline')}.`);
      }
    };

    if (ctx.simulate) {
      addAudit(ctx, app.id, 'apply.started', { driver: settings.applyDriver, simulated: true });
      await sleep(700);
      recordSuccess({ simulated: true, screenshot: null, note: 'SIMULATE: no real submission occurred', driver: settings.applyDriver });
      return;
    }

    // ---------------------------------------------------------------------
    // 1. What kind of apply target is this? (derived + persisted)
    // ---------------------------------------------------------------------
    let channel: ApplyChannel = classifyApplyChannel({
      canonicalUrl: job.canonicalUrl,
      source: job.source,
      descriptionMd: job.descriptionMd,
    });
    if (job.applyChannel !== channel) job = updateJob(ctx, job.id, { applyChannel: channel });
    addAudit(ctx, app.id, 'apply.channel', { channel, url: job.canonicalUrl });

    if (channel === 'email') {
      const drafted = await applyByEmail(ctx, app, job);
      if (drafted) return; // the Outbox approval is the submission gate now
      parkOutOfPipeline(
        ctx, app, job, 'needs_manual',
        {
          kind: 'other',
          text:
            'This posting is applied to by email, but no contact address appears anywhere in the stored posting text. ' +
            'Open the posting, find the address, and send the drafted resume and cover letter by hand.',
        },
        `${job.company} — ${job.title} has no contact address; apply by hand`,
      );
      addAudit(ctx, app.id, 'apply.needs_manual', { reason: 'email channel with no contact address' });
      throw new TerminalFailure('Apply by email, but no contact address was found in the posting');
    }

    if (channel === 'unknown' || !job.canonicalUrl) {
      parkOutOfPipeline(
        ctx, app, job, 'needs_manual',
        {
          kind: 'other',
          text: job.canonicalUrl
            ? `Homer could not classify ${job.canonicalUrl} as an application form, so nothing was submitted. Review it and apply by hand if it is real.`
            : 'This job has no posting URL, so there is nothing to submit to. Apply by hand and drag the card to Applied.',
        },
        `${job.company} — ${job.title} needs a manual apply (no usable form link)`,
      );
      addAudit(ctx, app.id, 'apply.needs_manual', { reason: 'unclassifiable apply target', url: job.canonicalUrl });
      throw new TerminalFailure('No employer application form to submit to — apply by hand');
    }

    // ---------------------------------------------------------------------
    // 2. Aggregator redirect: find the employer before doing anything else
    // ---------------------------------------------------------------------
    if (channel === 'aggregator_redirect') {
      const trace = await followRedirectChain(job.canonicalUrl, { fetchImpl: ctx.httpFetch });
      const destination = classifyApplyChannel({ canonicalUrl: trace.finalUrl, source: job.source });
      const resolved = destination === 'ats_form' && !trace.sameHost;
      addAudit(ctx, app.id, 'apply.redirect_followed', {
        from: job.canonicalUrl,
        to: trace.finalUrl,
        hops: trace.hops.length - 1,
        status: trace.status,
        resolved,
      });
      if (resolved) {
        job = updateJob(ctx, job.id, { canonicalUrl: trace.finalUrl, applyChannel: 'ats_form' }, 'job.scored');
        channel = 'ats_form';
        addAdvisory(ctx, app, {
          kind: 'other',
          text: `The stored link was an aggregator redirect; it resolved to the employer's own form at ${trace.finalUrl}, which is where this application was sent.`,
        });
      } else {
        parkOutOfPipeline(
          ctx, app, job, 'needs_manual',
          {
            kind: 'other',
            text:
              `The stored link is a job-aggregator redirect (${job.canonicalUrl}) and it dead-ends on the aggregator's own site ` +
              `(${trace.finalUrl}) rather than an employer form. Nothing was submitted. Search the company's careers page for this role and apply there.`,
          },
          `${job.company} — ${job.title} is an aggregator link, not an employer form`,
        );
        addAudit(ctx, app.id, 'apply.needs_manual', { reason: 'aggregator redirect dead-ended', finalUrl: trace.finalUrl });
        throw new TerminalFailure('The posting link is a job-aggregator redirect, not an employer application form');
      }
    }

    // ---------------------------------------------------------------------
    // 3. Liveness — before any form interaction, and before any other diagnosis
    // ---------------------------------------------------------------------
    const liveness = await checkPostingLiveness(job.canonicalUrl, {
      externalId: job.externalId,
      fetchImpl: ctx.httpFetch,
    });
    addAudit(ctx, app.id, 'apply.liveness', {
      url: job.canonicalUrl,
      alive: liveness.alive,
      reason: liveness.reason,
      status: liveness.status,
      evidence: liveness.evidence,
    });

    if (!liveness.alive) {
      // 3a. Re-resolution: the role may simply have been re-issued a new id.
      const rr = await reresolvePosting(
        {
          url: job.canonicalUrl,
          externalId: job.externalId,
          title: job.title,
          location: job.location,
          board: liveness.board,
        },
        { fetchImpl: ctx.httpFetch },
      );
      addAudit(ctx, app.id, 'apply.reresolve', {
        outcome: rr.outcome,
        detail: rr.detail,
        matched: rr.posting ? { id: rr.posting.id, title: rr.posting.title } : null,
        openings: rr.openings.map((p) => `${p.title}${p.location ? ` (${p.location})` : ''}`),
      });

      if (rr.outcome === 'resolved' && rr.posting && rr.ref) {
        const freshUrl = postingUrl(rr.ref, rr.posting);
        const freshExternalId = `${rr.ref.ats}:${rr.ref.slug}:${rr.posting.id}`;
        job = updateJob(ctx, job.id, { canonicalUrl: freshUrl, externalId: freshExternalId }, 'job.scored');
        addAdvisory(ctx, app, {
          kind: 'other',
          text:
            `The stored posting id had changed on ${rr.ref.ats}; it was re-resolved to the company's current listing ` +
            `for “${rr.posting.title}” (${freshUrl}) and the application was sent there.`,
        });
        ctx.bus.emit({
          type: 'toast',
          level: 'info',
          message: `${job.company} re-listed this role — applying to the current posting`,
        });
      } else {
        const detail =
          rr.outcome === 'ambiguous'
            ? `${rr.detail}. ${openingsList(rr.openings)}.`
            : rr.outcome === 'miss'
              ? `${rr.detail}. ${openingsList(rr.openings)}.`
              : rr.detail;
        parkOutOfPipeline(
          ctx, app, job, 'expired',
          {
            kind: 'other',
            text:
              `The posting at ${job.canonicalUrl} is no longer available (${liveness.evidence ?? liveness.reason}). ` +
              `${detail} Nothing was filled in and nothing was submitted.`,
          },
          `${job.company} — ${job.title} is no longer available`,
        );
        addAudit(ctx, app.id, 'apply.expired', {
          reason: liveness.reason,
          evidence: liveness.evidence,
          reresolve: rr.outcome,
          openings: rr.openings.map((p) => p.title),
        });
        throw new TerminalFailure(
          `Posting no longer available — ${liveness.evidence ?? liveness.reason}. ${detail}`,
        );
      }
    }

    // ---------------------------------------------------------------------
    // 4. Drive the form
    // ---------------------------------------------------------------------
    // Hostile sources always go through the human-paced Chrome flow (PRD D5/§8).
    const driverName = job.source === 'linkedin' ? 'chrome' : settings.applyDriver;
    const driver = ctx.applyDriverFactory(driverName);
    const auditDir = path.join(ctx.artifactsDir, 'applications', String(app.id), 'audit');
    addAudit(ctx, app.id, 'apply.started', { driver: driverName, url: job.canonicalUrl, channel });

    try {
      const outcome = await driver.apply({
        target: { url: job.canonicalUrl, company: job.company, title: job.title },
        profile: buildApplyProfile(ctx, app),
        auditDir,
        submit: true, // only reached with an approval record (checked above)
        credentials: vaultCredentialStore(ctx),
        runner: ctx.runner,
        optionModel: settings.modelScore, // cheap tier for "pick one of these options"
        timeoutMs: ctx.config.agent.defaultTimeoutMs,
      });

      if (!outcome.submitted) {
        addAudit(ctx, app.id, 'apply.prestaged', {
          driver: driverName,
          screenshots: outcome.screenshots.map((s) => s.path),
          filledFields: outcome.filledFields,
        });
        throw new NeedsHuman(
          `The ${job.company} form was pre-staged but not submitted. Review the open browser, submit manually, then resolve this task.`,
          { applicationId: app.id, parkReason: 'driver_manual' satisfies ParkReason },
        );
      }

      recordSuccess({
        driver: driverName,
        ats: outcome.ats,
        confirmation: outcome.confirmationText,
        screenshot: outcome.screenshots.find((s) => s.stage === 'confirmation')?.path ?? null,
        screenshots: outcome.screenshots.map((s) => ({ stage: s.stage, path: s.path })),
        filledFields: outcome.filledFields,
        answersUsed: outcome.answersUsed,
      });
      await driver.dispose().catch(() => undefined);
    } catch (err) {
      if (err instanceof ApplyBlocked) {
        // The driver's own liveness pass caught what the pre-flight could not
        // (a JS-rendered "no longer accepting applications"). That is an
        // expired posting, not a wall for the user to clear.
        if (err.reason === 'dead_posting') {
          await driver.dispose().catch(() => undefined);
          addAudit(ctx, app.id, 'apply.expired', { source: 'driver', prompt: err.prompt.slice(0, 1000) });
          parkOutOfPipeline(
            ctx, app, job, 'expired',
            { kind: 'other', text: `${err.prompt} The card was moved out of Ready for review.` },
            `${job.company} — ${job.title} is no longer available`,
          );
          throw new TerminalFailure('Posting no longer available');
        }
        // Browser intentionally left open (FR-25); the audit keeps the evidence.
        addAudit(ctx, app.id, 'apply.blocked', {
          driver: driverName,
          parkReason: err.reason,
          prompt: err.prompt.slice(0, 2000),
          screenshots: err.screenshots.map((s) => ({ stage: s.stage, path: s.path })),
          choices: err.choices,
        });
        // The real option sets ride along on the task payload so the dashboard
        // can render them as one-click choices instead of a wall of text, and
        // parkReason lets the card name the blocker instead of guessing.
        throw new NeedsHuman(err.prompt, {
          applicationId: app.id,
          parkReason: err.reason,
          ...(err.choices.length > 0 ? { choices: err.choices } : {}),
        });
      }
      if (err instanceof NeedsHuman || err instanceof TerminalFailure) throw err;
      await driver.dispose().catch(() => undefined);
      addAudit(ctx, app.id, 'apply.failed', { driver: driverName, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
};
