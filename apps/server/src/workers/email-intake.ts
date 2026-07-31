// Email intake (FR-2) — shared by the email_scan worker (agent w/ Gmail MCP)
// and the /api/internal/email-bridge routes (interactive session bridge).
// Classified inbound emails become: application status updates, new opportunity
// job records, and interview_invite → schedule event + prep_guide task.
// Idempotent by threadKey (a re-scan never duplicates records).
// Email bodies are untrusted input: they are stored and classified, never
// followed as instructions (PRD §8).
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { EmailMatchBasis, EmailMatchCandidate } from '@shared/types';
import { applications, emails, jobs, scheduleEvents } from '../db/schema';
import { toEmail, toScheduleEvent } from '../db/serialize';
import { upsertJob } from '../sources/dedupe';
import { toJob } from '../db/serialize';
import { updateApplication, updateJob } from './helpers';
import type { AppContext } from '../context';

export const EMAIL_CLASSIFICATIONS = [
  'reply_accepted', 'reply_rejected', 'interview_invite', 'offer', 'opportunity', 'followup', 'other',
] as const;

export const scanItemSchema = z.object({
  threadKey: z.string().min(1),
  subject: z.string().default(''),
  from: z.string().default(''),
  receivedAt: z.string().nullish(),
  classification: z.enum(EMAIL_CLASSIFICATIONS),
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
  /** Only on `offer`: what the employer put on the table, as they stated it. */
  offer: z
    .object({
      /** Verbatim compensation figure or range from the email. */
      salary: z.string().nullish(),
      /** ISO date the employer wants an answer by — becomes a Schedule deadline. */
      respondBy: z.string().nullish(),
      startDate: z.string().nullish(),
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
  offersRecorded: number;
  /** Emails that could belong to more than one application and now ask the user. */
  ambiguous: number;
}

// --- application matching -------------------------------------------------
//
// The old matcher was `LIKE '%company%'` + `.get()`: the first row SQLite
// returned won. Two applications at one employer meant a rejection could close
// the wrong one. This scores every candidate on the signals actually available
// and refuses to pick when nothing separates the top two — an unlinked email
// the user can assign is recoverable; a wrong link quietly is not.

/** Company names compare without case, punctuation, or legal suffixes. */
function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|ab|plc|sa|srl|pty|holdings|group|technologies|labs?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Canonical URL comparison: scheme, www, trailing slash and query are noise. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

const TITLE_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'to', 'at', 'in', 'i', 'ii', 'iii', 'senior', 'junior']);

function titleTokens(title: string): Set<string> {
  return new Set(
    title.toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t)),
  );
}

/** Jaccard overlap of the meaningful words in two job titles, 0..1. */
function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Applications still in play outrank ones that already closed. */
const LIVE_STATUSES = new Set(['applied', 'interview', 'offer', 'ready_for_review']);

/** Two candidates within this many points of each other are not distinguishable. */
export const AMBIGUITY_MARGIN = 5;

export interface MatchResult {
  appId: number;
  jobId: number;
  basis: EmailMatchBasis;
}

export interface MatchOutcome {
  matched: MatchResult | null;
  /** Populated only when the email is genuinely ambiguous. */
  candidates: EmailMatchCandidate[];
}

type MatchRow = { appId: number; jobId: number; company: string; title: string; status: string; updatedAt: string; canonicalUrl: string };

const toCandidate = (r: MatchRow): EmailMatchCandidate => ({
  applicationId: r.appId,
  jobId: r.jobId,
  company: r.company,
  title: r.title,
  status: r.status as EmailMatchCandidate['status'],
});

export function matchApplication(
  ctx: AppContext,
  item: Pick<ScanItem, 'company' | 'jobTitle' | 'jobUrl'>,
): MatchOutcome {
  const rows = ctx.db
    .select({
      appId: applications.id,
      jobId: jobs.id,
      company: jobs.company,
      title: jobs.title,
      status: applications.status,
      updatedAt: applications.updatedAt,
      canonicalUrl: jobs.canonicalUrl,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .all();
  if (rows.length === 0) return { matched: null, candidates: [] };

  // (d) The posting URL is the strongest signal there is — take it and stop.
  if (item.jobUrl) {
    const wanted = normalizeUrl(item.jobUrl);
    const byUrl = rows.filter((r) => r.canonicalUrl && normalizeUrl(r.canonicalUrl) === wanted);
    if (byUrl.length === 1) {
      return { matched: { appId: byUrl[0]!.appId, jobId: byUrl[0]!.jobId, basis: 'url' }, candidates: [] };
    }
  }

  // (a) Company, normalized. Nothing else can identify an application without it.
  if (!item.company) return { matched: null, candidates: [] };
  const wantedCompany = normalizeCompany(item.company);
  if (wantedCompany === '') return { matched: null, candidates: [] };
  const sameCompany = rows.filter((r) => {
    const c = normalizeCompany(r.company);
    return c === wantedCompany || c.includes(wantedCompany) || wantedCompany.includes(c);
  });
  if (sameCompany.length === 0) return { matched: null, candidates: [] };
  if (sameCompany.length === 1) {
    const only = sameCompany[0]!;
    return { matched: { appId: only.appId, jobId: only.jobId, basis: 'company' }, candidates: [] };
  }

  // (b) + (c) Several applications at one employer: separate them by title, and
  // failing that by whether they are still in play.
  const newest = sameCompany.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  const scored = sameCompany
    .map((r) => ({
      row: r,
      titleScore: item.jobTitle ? titleSimilarity(item.jobTitle, r.title) * 40 : 0,
      score:
        (normalizeCompany(r.company) === wantedCompany ? 50 : 30) +
        (item.jobTitle ? titleSimilarity(item.jobTitle, r.title) * 40 : 0) +
        (LIVE_STATUSES.has(r.status) ? 8 : 0) +
        (r.appId === newest.appId ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const [top, runnerUp] = scored;
  if (top && runnerUp && top.score - runnerUp.score >= AMBIGUITY_MARGIN) {
    return {
      matched: {
        appId: top.row.appId,
        jobId: top.row.jobId,
        basis: top.titleScore > 0 ? 'company_title' : 'company',
      },
      candidates: [],
    };
  }
  // Nothing separates them. Ask rather than guess.
  return { matched: null, candidates: sameCompany.map(toCandidate) };
}

/**
 * Status effect of a classification on the application it is about. Shared by
 * intake and the manual "this email is about that application" assignment, so
 * resolving an ambiguous email lands exactly the update the scan would have.
 */
export function applyClassificationEffect(
  ctx: AppContext,
  classification: string,
  target: { appId: number; jobId: number },
): boolean {
  // Job first: updateApplication emits application.updated with the job fetched
  // at emit time, so the job row must already carry the new status.
  if (classification === 'offer') {
    updateJob(ctx, target.jobId, { status: 'offer' });
    updateApplication(ctx, target.appId, { status: 'offer' });
    return true;
  }
  if (classification === 'reply_accepted' || classification === 'interview_invite') {
    updateJob(ctx, target.jobId, { status: 'interview' });
    updateApplication(ctx, target.appId, { status: 'interview' });
    return true;
  }
  if (classification === 'reply_rejected') {
    updateJob(ctx, target.jobId, { status: 'rejected' });
    updateApplication(ctx, target.appId, { status: 'rejected' });
    return true;
  }
  return false;
}

/** Offer terms folded into the stored summary — the figures stay the employer's words. */
function withOfferTerms(summary: string, offer: ScanItem['offer']): string {
  if (!offer) return summary;
  const terms = [
    offer.salary ? `compensation ${offer.salary}` : null,
    offer.startDate ? `start ${offer.startDate}` : null,
    offer.respondBy ? `respond by ${offer.respondBy}` : null,
  ].filter((t): t is string => t != null);
  if (terms.length === 0) return summary;
  return summary ? `${summary} [offer: ${terms.join('; ')}]` : `Offer: ${terms.join('; ')}`;
}

/** Process classified scan items into DB records + follow-on tasks. */
export function processScanItems(ctx: AppContext, items: ScanItem[]): IntakeSummary {
  const summary: IntakeSummary = {
    inserted: 0,
    skippedExisting: 0,
    applicationsUpdated: 0,
    opportunitiesCreated: 0,
    interviewsScheduled: 0,
    offersRecorded: 0,
    ambiguous: 0,
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

    const { matched, candidates } = matchApplication(ctx, item);
    if (!matched && candidates.length > 0) summary.ambiguous += 1;
    const email = ctx.db
      .insert(emails)
      .values({
        threadKey: item.threadKey,
        direction: 'inbound',
        classification: item.classification,
        applicationId: matched?.appId ?? null,
        subject: item.subject,
        summary: withOfferTerms(item.summary, item.classification === 'offer' ? item.offer : null),
        bodyMd: item.bodyMd ?? null,
        receivedAt: item.receivedAt ?? new Date().toISOString(),
        matchBasis: matched?.basis ?? null,
        matchCandidatesJson: JSON.stringify(candidates),
      })
      .returning()
      .get();
    summary.inserted += 1;
    ctx.bus.emit({ type: 'email.received', email: toEmail(email) });

    // (a) Status updates for tracked applications.
    if (matched && applyClassificationEffect(ctx, item.classification, matched)) {
      summary.applicationsUpdated += 1;
    }
    if (!matched && candidates.length > 0) {
      ctx.bus.emit({
        type: 'toast',
        level: 'warning',
        message: `An email from ${item.company} matches ${candidates.length} of your applications — pick the right one in the Inbox`,
      });
    }

    // (a2) An offer is the outcome the whole pipeline exists for — say so.
    if (item.classification === 'offer') {
      summary.offersRecorded += 1;
      if (matched) {
        ctx.bus.emit({
          type: 'toast',
          level: 'success',
          message: `Offer from ${item.company ?? item.subject}`,
          celebrate: true,
        });
      }
      // A stated deadline is a real commitment — it belongs on the Schedule.
      if (item.offer?.respondBy) {
        const title = `Respond to the ${item.company ?? 'employer'} offer`;
        const dup = ctx.db
          .select()
          .from(scheduleEvents)
          .where(and(eq(scheduleEvents.title, title), eq(scheduleEvents.startsAt, item.offer.respondBy)))
          .get();
        if (!dup) {
          const event = ctx.db
            .insert(scheduleEvents)
            .values({
              type: 'deadline',
              applicationId: matched?.appId ?? null,
              title,
              startsAt: item.offer.respondBy,
              company: item.company ?? null,
            })
            .returning()
            .get();
          ctx.bus.emit({ type: 'schedule.updated', event: toScheduleEvent(event) });
        }
      }
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
