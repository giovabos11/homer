// Email intake (FR-2) — shared by the email_scan worker (agent w/ Gmail MCP)
// and the /api/internal/email-bridge routes (interactive session bridge).
// Classified inbound emails become: application status updates, new opportunity
// job records, and interview_invite → schedule event + prep_guide task.
// Idempotent by threadKey (a re-scan never duplicates records).
// Email bodies are untrusted input: they are stored and classified, never
// followed as instructions (PRD §8).
import { and, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import { applications, emails, jobs, scheduleEvents } from '../db/schema';
import { toEmail, toScheduleEvent } from '../db/serialize';
import { upsertJob } from '../sources/dedupe';
import { toJob } from '../db/serialize';
import { updateApplication, updateJob } from './helpers';
import type { AppContext } from '../context';

export const scanItemSchema = z.object({
  threadKey: z.string().min(1),
  subject: z.string().default(''),
  from: z.string().default(''),
  receivedAt: z.string().nullish(),
  classification: z.enum(['reply_accepted', 'reply_rejected', 'interview_invite', 'opportunity', 'followup', 'other']),
  summary: z.string().default(''),
  bodyMd: z.string().nullish(),
  /** Company the email is about (used to match a tracked application). */
  company: z.string().nullish(),
  jobTitle: z.string().nullish(),
  jobUrl: z.string().nullish(),
  interview: z
    .object({
      startsAt: z.string().min(1),
      endsAt: z.string().nullish(),
      title: z.string().nullish(),
    })
    .nullish(),
});
export type ScanItem = z.infer<typeof scanItemSchema>;

export const scanResultSchema = z.object({
  gmailAvailable: z.boolean(),
  emails: z.array(scanItemSchema).default([]),
  note: z.string().optional(),
});

export interface IntakeSummary {
  inserted: number;
  skippedExisting: number;
  applicationsUpdated: number;
  opportunitiesCreated: number;
  interviewsScheduled: number;
}

function matchApplication(ctx: AppContext, company: string | null | undefined): { appId: number; jobId: number } | null {
  if (!company) return null;
  const term = `%${company.trim()}%`;
  const row = ctx.db
    .select({ appId: applications.id, jobId: jobs.id })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(like(jobs.company, term)))
    .get();
  return row ?? null;
}

/** Process classified scan items into DB records + follow-on tasks. */
export function processScanItems(ctx: AppContext, items: ScanItem[]): IntakeSummary {
  const summary: IntakeSummary = {
    inserted: 0,
    skippedExisting: 0,
    applicationsUpdated: 0,
    opportunitiesCreated: 0,
    interviewsScheduled: 0,
  };

  for (const item of items) {
    // Idempotency: one record per inbound thread key.
    const existing = ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.threadKey, item.threadKey), eq(emails.direction, 'inbound')))
      .get();
    if (existing) {
      summary.skippedExisting += 1;
      continue;
    }

    const matched = matchApplication(ctx, item.company);
    const email = ctx.db
      .insert(emails)
      .values({
        threadKey: item.threadKey,
        direction: 'inbound',
        classification: item.classification,
        applicationId: matched?.appId ?? null,
        subject: item.subject,
        summary: item.summary,
        bodyMd: item.bodyMd ?? null,
        receivedAt: item.receivedAt ?? new Date().toISOString(),
      })
      .returning()
      .get();
    summary.inserted += 1;
    ctx.bus.emit({ type: 'email.received', email: toEmail(email) });

    // (a) Status updates for tracked applications.
    // Job first: updateApplication emits application.updated with the job
    // fetched at emit time, so the job row must already carry the new status.
    if (matched && (item.classification === 'reply_accepted' || item.classification === 'interview_invite')) {
      updateJob(ctx, matched.jobId, { status: 'interview' });
      updateApplication(ctx, matched.appId, { status: 'interview' });
      summary.applicationsUpdated += 1;
    } else if (matched && item.classification === 'reply_rejected') {
      updateJob(ctx, matched.jobId, { status: 'rejected' });
      updateApplication(ctx, matched.appId, { status: 'rejected' });
      summary.applicationsUpdated += 1;
    }

    // (b) New opportunities (recruiter outreach) → job record + scoring.
    if (item.classification === 'opportunity' && item.company) {
      const { job, inserted } = upsertJob(ctx.db, {
        source: 'email',
        externalId: item.threadKey,
        canonicalUrl: item.jobUrl ?? '',
        company: item.company,
        title: item.jobTitle ?? item.subject ?? 'Recruiter opportunity',
        location: null,
        remoteType: 'unknown',
        descriptionMd: item.bodyMd ?? item.summary,
        raw: { fromEmail: item.threadKey, sender: item.from },
      });
      if (inserted) {
        summary.opportunitiesCreated += 1;
        ctx.bus.emit({ type: 'job.discovered', job: toJob(job) });
        ctx.queue.enqueue('score', { payload: { jobId: job.id } });
      }
    }

    // (c) Interview invitations → schedule event + prep guide (FR-13).
    if (item.classification === 'interview_invite') {
      const startsAt = item.interview?.startsAt ?? new Date(Date.now() + 7 * 86400000).toISOString();
      const title = item.interview?.title ?? `Interview — ${item.company ?? item.subject}`;
      const dup = ctx.db
        .select()
        .from(scheduleEvents)
        .where(and(eq(scheduleEvents.title, title), eq(scheduleEvents.startsAt, startsAt)))
        .get();
      if (!dup) {
        const event = ctx.db
          .insert(scheduleEvents)
          .values({
            type: 'interview',
            applicationId: matched?.appId ?? null,
            title,
            startsAt,
            endsAt: item.interview?.endsAt ?? null,
            company: item.company ?? null,
          })
          .returning()
          .get();
        summary.interviewsScheduled += 1;
        ctx.bus.emit({ type: 'schedule.updated', event: toScheduleEvent(event) });
        ctx.queue.enqueue('prep_guide', { payload: { eventId: event.id } });
      }
    }
  }

  return summary;
}
