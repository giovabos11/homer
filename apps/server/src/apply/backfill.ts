// One-time (idempotent) apply-channel backfill.
//
// The channel column landed after the database already held hundreds of jobs and
// a queue of approved applications, most of which were not applyable at all.
// This pass classifies every existing row and, for the ones already sitting in
// Ready for review with an approval on them, records an advisory saying plainly
// that Homer cannot submit that one on its own. Nothing is deleted, no approval
// is revoked, and nothing is enqueued: the point is to stop the board implying a
// submission that was never going to happen.
//
// Idempotent by construction — classification is a pure function of the row, and
// advisories are merged by normalized text, so a second run changes nothing.
import { eq } from 'drizzle-orm';
import type { Advisory, ApplyChannel } from '@shared/types';
import { APPLY_CHANNEL_LABELS } from '@shared/types';
import type { Db } from '../db/client';
import { applications, jobs } from '../db/schema';
import { mergeAdvisories, parseAdvisories } from '../docs/advisories';
import { classifyApplyChannel, extractContactEmail } from './channel';

export interface ChannelBackfillResult {
  scanned: number;
  /** Rows whose stored channel changed (0 on a repeat run). */
  updated: number;
  counts: Record<ApplyChannel, number>;
  /** Approved-but-unsubmitted applications, bucketed by their job's channel. */
  approved: { total: number; byChannel: Record<ApplyChannel, number>; notAutoApplyable: number };
  /** Applications that gained a "cannot be auto-submitted" advisory this run. */
  flagged: number;
}

function emptyCounts(): Record<ApplyChannel, number> {
  return { ats_form: 0, aggregator_redirect: 0, email: 0, unknown: 0 };
}

/** The advisory a non-ats_form approved application carries. */
export function channelAdvisory(channel: ApplyChannel, hasEmail: boolean): Advisory | null {
  if (channel === 'ats_form') return null;
  if (channel === 'aggregator_redirect') {
    return {
      kind: 'other',
      text:
        'The stored link is a job-aggregator redirect, not the employer\'s application form. Homer follows it to the real posting before applying; when it dead-ends on the aggregator this application moves to Manual so you can find the employer listing yourself.',
    };
  }
  if (channel === 'email') {
    return {
      kind: 'other',
      text: hasEmail
        ? 'This posting is applied to by email, not through a form. Homer drafts the application email into the Outbox and waits for your approval before anything is sent.'
        : 'This posting is applied to by email, but no contact address appears in the stored text. Open the posting and apply by hand; Homer will not submit anything.',
    };
  }
  return {
    kind: 'other',
    text: 'Homer could not classify this link as an application form, so it will not be submitted automatically. Review it and apply by hand if it is real.',
  };
}

/**
 * Classify every job, then annotate the approved applications that cannot be
 * auto-submitted. Safe to run on every boot.
 */
export function backfillApplyChannels(db: Db): ChannelBackfillResult {
  const rows = db
    .select({
      id: jobs.id,
      source: jobs.source,
      canonicalUrl: jobs.canonicalUrl,
      descriptionMd: jobs.descriptionMd,
      applyChannel: jobs.applyChannel,
    })
    .from(jobs)
    .all();

  const result: ChannelBackfillResult = {
    scanned: rows.length,
    updated: 0,
    counts: emptyCounts(),
    approved: { total: 0, byChannel: emptyCounts(), notAutoApplyable: 0 },
    flagged: 0,
  };

  const channelByJob = new Map<number, ApplyChannel>();
  for (const row of rows) {
    const channel = classifyApplyChannel({
      canonicalUrl: row.canonicalUrl,
      source: row.source,
      descriptionMd: row.descriptionMd,
    });
    channelByJob.set(row.id, channel);
    result.counts[channel] += 1;
    if (row.applyChannel !== channel) {
      db.update(jobs).set({ applyChannel: channel }).where(eq(jobs.id, row.id)).run();
      result.updated += 1;
    }
  }

  // Approved but not yet submitted — the cards the user is looking at right now.
  const apps = db
    .select({
      id: applications.id,
      jobId: applications.jobId,
      approvedAt: applications.approvedAt,
      submittedAt: applications.submittedAt,
      advisoriesJson: applications.advisoriesJson,
    })
    .from(applications)
    .all();

  for (const app of apps) {
    if (!app.approvedAt || app.submittedAt) continue;
    const channel = channelByJob.get(app.jobId) ?? 'unknown';
    result.approved.total += 1;
    result.approved.byChannel[channel] += 1;
    if (channel === 'ats_form') continue;
    result.approved.notAutoApplyable += 1;

    const job = rows.find((r) => r.id === app.jobId);
    const advisory = channelAdvisory(channel, extractContactEmail(job?.descriptionMd ?? '') != null);
    if (!advisory) continue;
    const existing = parseAdvisories(app.advisoriesJson);
    const merged = mergeAdvisories(existing, [advisory]);
    if (merged.length === existing.length) continue; // already recorded
    db.update(applications).set({ advisoriesJson: JSON.stringify(merged) }).where(eq(applications.id, app.id)).run();
    result.flagged += 1;
  }

  return result;
}

/** Human-readable one-liner for the boot log / the CLI report. */
export function describeBackfill(r: ChannelBackfillResult): string {
  const counts = (Object.keys(r.counts) as ApplyChannel[])
    .filter((c) => r.counts[c] > 0)
    .map((c) => `${r.counts[c]} ${APPLY_CHANNEL_LABELS[c].toLowerCase()}`)
    .join(', ');
  return (
    `[apply-channel] classified ${r.scanned} job(s): ${counts || 'none'} ` +
    `(${r.updated} updated) · ${r.approved.notAutoApplyable}/${r.approved.total} approved application(s) are not auto-applyable` +
    (r.flagged > 0 ? ` · ${r.flagged} advisory note(s) added` : '')
  );
}
