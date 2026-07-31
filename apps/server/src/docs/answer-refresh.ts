// Retroactive standing-answer resolution.
//
// The resolution order is "standing answer → profile rule → needs_user", but an
// application stores the answers as they resolved AT DRAFTING TIME. An
// application drafted before the user filled in their standing answers keeps
// asking questions the user has since answered once and for all, which is
// exactly the situation standing answers exist to end.
//
// This sweep re-applies the first layer to applications that are still waiting:
// any unanswered question whose standing key(s) now have values is filled from
// the user's own words. It invents nothing (only the user's stored values are
// used), it never touches an answered question, and it never approves or
// submits anything — it only removes questions the user has already answered.
import { eq } from 'drizzle-orm';
import type { StandingAnswers } from '@shared/types';
import type { Db } from '../db/client';
import { applications, jobs } from '../db/schema';
import { isAdvisoryQuestion } from './advisories';
import { displayStandingValue, salaryAnswer, standingKeysForQuestion } from './screening';
import { standingValue } from './standing';

/** Statuses where the screening answers are still in play. */
const OPEN_STATUSES = new Set(['tailoring', 'ready_for_review']);

function isUnanswered(v: unknown): boolean {
  if (typeof v === 'object' && v !== null) return (v as { status?: string }).status === 'needs_user';
  if (typeof v !== 'string') return false;
  return v === 'FLAGGED_FOR_USER' || /^flagged\b/i.test(v);
}

export interface AnswerRefreshResult {
  changed: number;
  resolved: number;
  perApplication: { id: number; questions: string[] }[];
}

export function refreshStandingResolvedAnswers(db: Db, standing: StandingAnswers): AnswerRefreshResult {
  const rows = db
    .select({ id: applications.id, jobId: applications.jobId, status: applications.status, answersJson: applications.answersJson })
    .from(applications)
    .all();

  const result: AnswerRefreshResult = { changed: 0, resolved: 0, perApplication: [] };

  for (const row of rows) {
    if (!row.answersJson || !OPEN_STATUSES.has(row.status)) continue;
    let answers: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.answersJson) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      answers = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const filled: string[] = [];
    for (const [question, value] of Object.entries(answers)) {
      // Sponsorship is stored lowercase for the apply driver's matching; an
      // application form should read "No", not "no".
      if ((value === 'yes' || value === 'no') && standingKeysForQuestion(question)[0] === 'requiresSponsorship') {
        answers[question] = displayStandingValue('requiresSponsorship', value);
        filled.push(question);
        continue;
      }
      if (!isUnanswered(value) || isAdvisoryQuestion(question)) continue;
      const keys = standingKeysForQuestion(question);
      if (keys.length === 0) continue;
      const values = keys.map((k) => displayStandingValue(k, standingValue(standing, k)));
      if (!values.every((v) => v !== '')) continue; // half an answer is a wrong one
      if (keys.length === 1 && keys[0] === 'salaryExpectation') {
        const job = db.select().from(jobs).where(eq(jobs.id, row.jobId)).get();
        answers[question] = salaryAnswer(values[0]!, job ?? null);
      } else {
        answers[question] = values.join('; ');
      }
      filled.push(question);
    }
    if (filled.length === 0) continue;

    db.update(applications).set({ answersJson: JSON.stringify(answers) }).where(eq(applications.id, row.id)).run();
    result.changed += 1;
    result.resolved += filled.length;
    result.perApplication.push({ id: row.id, questions: filled });
  }

  return result;
}
