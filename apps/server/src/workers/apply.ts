// Apply worker (REAL — FR-9, FR-25, FR-30, PRD D5, §6.2).
//
//  - Requires an approval record (user click or logged auto-approval per the
//    gate) before anything touches a browser; submission itself only happens
//    because that approval exists.
//  - Driver selection: settings.applyDriver, with automation-hostile sources
//    (LinkedIn) always routed through ChromeApplyDriver, which parks the task
//    for the human-paced claude-in-chrome flow.
//  - Captcha / login wall / flagged screening questions → the driver throws
//    ApplyBlocked; this worker records the audit trail and re-throws as
//    NeedsHuman so the dashboard alerts and the browser stays open (FR-25).
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
import { toScheduleEvent } from '../db/serialize';
import { credentialsMeta, followups, scheduleEvents } from '../db/schema';
import { readProfile } from '../api/core';
import { appendOutcomeNote } from '../docs/archive';
import { normalizeAnswers } from '../docs/screening';
import { ApplyBlocked, type ApplyCredentialStore, type ApplyProfile } from '../apply/driver';
import { addAudit, getApplication, getJob, sleep, updateApplication, updateJob, type ApplicationRow } from './helpers';
import { NeedsHuman, type Worker, type WorkerArgs } from './registry';
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

export const applyWorker: Worker = {
  type: 'apply',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { applicationId?: number };
    const app = payload.applicationId != null ? getApplication(ctx, payload.applicationId) : null;
    if (!app) return;
    const job = getJob(ctx, app.jobId);
    if (!job) return;

    if (!app.approvedAt) {
      throw new Error(`Application ${app.id} has no approval record — the submit gate must run first`);
    }
    if (app.submittedAt) return; // idempotent: never double-submit

    const settings = ctx.settings.get();
    const now = new Date();

    const recordSuccess = (audit: Record<string, unknown>) => {
      // Job first: updateApplication emits application.updated with the job
      // fetched at emit time, so the job row must already say 'applied'.
      updateJob(ctx, job.id, { status: 'applied' });
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
          title: `Follow up: ${job.company} — ${job.title}`,
          startsAt: due.toISOString(),
          company: job.company,
        })
        .returning()
        .get();
      ctx.bus.emit({ type: 'schedule.updated', event: toScheduleEvent(event) });
      ctx.bus.emit({
        type: 'toast',
        level: 'success',
        message: `Applied to ${job.company} — ${job.title}`,
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

    if (!job.canonicalUrl) {
      throw new NeedsHuman(`Application ${app.id} has no posting URL — apply manually, then resolve this task.`);
    }

    // Hostile sources always go through the human-paced Chrome flow (PRD D5/§8).
    const driverName = job.source === 'linkedin' ? 'chrome' : settings.applyDriver;
    const driver = ctx.applyDriverFactory(driverName);
    const auditDir = path.join(ctx.artifactsDir, 'applications', String(app.id), 'audit');
    addAudit(ctx, app.id, 'apply.started', { driver: driverName, url: job.canonicalUrl });

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
        // Browser intentionally left open (FR-25); the audit keeps the evidence.
        addAudit(ctx, app.id, 'apply.blocked', {
          driver: driverName,
          prompt: err.prompt.slice(0, 2000),
          screenshots: err.screenshots.map((s) => ({ stage: s.stage, path: s.path })),
          choices: err.choices,
        });
        // The real option sets ride along on the task payload so the dashboard
        // can render them as one-click choices instead of a wall of text.
        throw new NeedsHuman(err.prompt, {
          applicationId: app.id,
          ...(err.choices.length > 0 ? { choices: err.choices } : {}),
        });
      }
      if (err instanceof NeedsHuman) throw err;
      await driver.dispose().catch(() => undefined);
      addAudit(ctx, app.id, 'apply.failed', { driver: driverName, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
};
