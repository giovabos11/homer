// Advisories — the drafter/reviewer's notes about ONE application.
//
// The distinction this module exists to enforce:
//   ANSWER    = a real form question. Somebody must type a value into a field.
//               Unanswered ones block approval and auto-submit. That is correct.
//   ADVISORY  = a note. "The posting wants MongoDB and your profile has none."
//               Nobody types that into a form; nothing is waiting on it.
//
// Advisories used to be written into applications.answers_json as
// { status: 'needs_user' } markers keyed "FLAG: …". Every application therefore
// arrived with 6-13 "questions" that could not be answered, Approve stayed
// locked and auto-submit never fired. They now live in their own column and are
// rendered read-only under the questions.
import { eq } from 'drizzle-orm';
import type { Advisory, AdvisoryKind, StandingAnswers } from '@shared/types';
import type { Db } from '../db/client';
import { applications } from '../db/schema';

/** Prefix the tailor used to write drafter flags into the answers map. */
export const ADVISORY_KEY_PREFIX = 'FLAG:';

/**
 * The defaults-table catch-all. It is a POLICY row ("never invent skills"), not
 * a question any form asks, so it must never be a blocking answer.
 */
export const CATCH_ALL_QUESTION_RE = /^skills,?\s*tools,?\s*or\s+experience\s+not\s+in\s+the\s+profile$/i;

/** True for a key that is a drafting note rather than a form question. */
export function isAdvisoryQuestion(question: string): boolean {
  const q = question.trim();
  return q.toUpperCase().startsWith(ADVISORY_KEY_PREFIX) || CATCH_ALL_QUESTION_RE.test(q);
}

/** "FLAG: Posting wants Rust" → "Posting wants Rust". */
export function stripAdvisoryPrefix(text: string): string {
  return text.replace(/^\s*FLAG:\s*/i, '').trim();
}

// Order matters: the first pattern that matches wins. Compensation and location
// are the most specific topics, so they are tested before the generic gap rule.
const KIND_PATTERNS: { kind: AdvisoryKind; re: RegExp }[] = [
  {
    kind: 'compensation',
    re: /salary|compensation|equity|base pay|pay range|pay band|\bcomp\b|\$\s?\d|posted range|below.*baseline|above.*baseline/i,
  },
  {
    kind: 'location',
    re: /relocat|on-?site|in-?person|hybrid|\bremote\b|bay area|\btravel\b|commut|days per week|based in/i,
  },
  {
    kind: 'unverified',
    re: /independently verified|could not (be )?verif|unverified|not verified|no verified|websearch|webfetch|reviewer (softened|corrected|correction|removed)|removed (an|a|the) (unverified|unsupported|fabricated)|comes? from the job posting text|claims? (in|from) the posting|no (named )?(recruiter|hiring manager)|addressed (generically|to)/i,
  },
  {
    kind: 'gap',
    re: /\bnot (in|on) (the |your |candidate )?(profile|file)\b|\bno\b[^.;]{0,60}\b(experience|exposure|background|familiarity|record|contributions?)\b|profile (has no|shows no|only|does not|lacks|documents)|\bnot claimed\b|\bon file\b|nice[- ]to[- ]have|\bprefer(s|red)\b|\bplus(es)?\b|\bbonus\b|\d\+\s*years/i,
  },
];

/** Bucket a note by topic so the review modal can group them. */
export function classifyAdvisory(text: string): AdvisoryKind {
  const body = stripAdvisoryPrefix(text);
  for (const p of KIND_PATTERNS) {
    if (p.re.test(body)) return p.kind;
  }
  return 'other';
}

/** Drafter/reviewer flag string → structured advisory. */
export function toAdvisory(text: string): Advisory {
  const body = stripAdvisoryPrefix(text).slice(0, 1000);
  return { kind: classifyAdvisory(body), text: body };
}

/** Parse a stored advisories_json blob defensively. */
export function parseAdvisories(raw: string | null | undefined): Advisory[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a) => {
        if (typeof a === 'string') return toAdvisory(a);
        const rec = a as Partial<Advisory>;
        if (typeof rec?.text !== 'string' || rec.text.trim() === '') return null;
        const kind: AdvisoryKind = rec.kind ?? classifyAdvisory(rec.text);
        return { kind, text: rec.text };
      })
      .filter((a): a is Advisory => a !== null);
  } catch {
    return [];
  }
}

const normalizeText = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Append without duplicating — the boot repair is allowed to run forever. */
export function mergeAdvisories(existing: Advisory[], incoming: Advisory[]): Advisory[] {
  const seen = new Set(existing.map((a) => normalizeText(a.text)));
  const out = [...existing];
  for (const a of incoming) {
    const key = normalizeText(a.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * What the salary rules need from a job. Accepts the DB row shape directly
 * (SQLite stores `salary_predicted` as 0/1) as well as the API `Job`.
 */
export interface JobSalaryContext {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPredicted?: boolean | number | null;
}

/**
 * The salary floor is a non-binding preference, so it never answers anything.
 * Its one job is this note: the posting's own range dips below what the user
 * said they would accept.
 */
export function salaryFloorAdvisory(job: JobSalaryContext, standing: StandingAnswers): Advisory | null {
  const floor = standing.salaryMinAcceptable;
  if (floor == null || !Number.isFinite(floor) || floor <= 0) return null;
  if (job.salaryPredicted) return null; // a guessed range is not the employer's word
  const low = job.salaryMin ?? job.salaryMax;
  if (low == null || !Number.isFinite(low)) return null;
  if (low >= floor) return null;
  return {
    kind: 'compensation',
    text:
      `The posted range starts at ${formatMoney(low, job.salaryCurrency)}, below the ` +
      `${formatMoney(floor, job.salaryCurrency)} minimum on file. Your floor is a preference, not a filter, ` +
      'so nothing was skipped or answered on your behalf.',
  };
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };

/** 130000 → "$130,000" (currency code prefix for anything without a symbol). */
export function formatMoney(amount: number, currency?: string | null): string {
  const code = (currency ?? 'USD').toUpperCase();
  const n = Math.round(amount).toLocaleString('en-US');
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${n}` : `${code} ${n}`;
}

// ---------------------------------------------------------------------------
// One-time repair of rows written before advisories existed.
// ---------------------------------------------------------------------------

export interface AdvisoryRepairResult {
  scanned: number;
  changed: number;
  movedEntries: number;
  perApplication: { id: number; before: number; after: number; moved: number }[];
}

/**
 * "Nobody has answered this." Covers the structured marker AND the legacy
 * `FLAGGED_FOR_USER` sentinel string that older rows still carry — both render
 * as "Needs your answer", so both must be treated as unanswered here.
 */
function isUnanswered(v: unknown): boolean {
  if (typeof v === 'object' && v !== null) return (v as { status?: string }).status === 'needs_user';
  if (typeof v !== 'string') return false;
  return v === 'FLAGGED_FOR_USER' || /^flagged\b/i.test(v);
}

/**
 * Move FLAG-keyed entries and the catch-all row out of `answers` and into
 * `advisories`. Idempotent: a second run finds nothing left to move. Real
 * answers (anything that is not an advisory key) are never touched, and a note
 * the user actually typed against a FLAG row is carried into the advisory text
 * rather than dropped.
 */
export function migrateApplicationAdvisories(db: Db): AdvisoryRepairResult {
  const rows = db
    .select({
      id: applications.id,
      answersJson: applications.answersJson,
      advisoriesJson: applications.advisoriesJson,
    })
    .from(applications)
    .all();

  const result: AdvisoryRepairResult = { scanned: rows.length, changed: 0, movedEntries: 0, perApplication: [] };

  for (const row of rows) {
    if (!row.answersJson) continue;
    let answers: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.answersJson) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      answers = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const before = Object.values(answers).filter(isUnanswered).length;
    const kept: Record<string, unknown> = {};
    const moved: Advisory[] = [];
    for (const [question, value] of Object.entries(answers)) {
      if (!isAdvisoryQuestion(question)) {
        kept[question] = value;
        continue;
      }
      if (CATCH_ALL_QUESTION_RE.test(question.trim())) {
        // A policy row, not a note about this posting. If the user typed a real
        // answer into it, that answer is theirs — keep it.
        if (!isUnanswered(value)) kept[question] = value;
        continue;
      }
      const note = stripAdvisoryPrefix(question);
      const userText = typeof value === 'string' && value.trim() !== '' && !isUnanswered(value) ? value.trim() : null;
      moved.push(toAdvisory(userText ? `${note} (your note: ${userText})` : note));
    }

    const removed = Object.keys(answers).length - Object.keys(kept).length;
    if (removed === 0) continue;

    const advisories = mergeAdvisories(parseAdvisories(row.advisoriesJson), moved);
    const after = Object.values(kept).filter(isUnanswered).length;
    db.update(applications)
      .set({ answersJson: JSON.stringify(kept), advisoriesJson: JSON.stringify(advisories) })
      .where(eq(applications.id, row.id))
      .run();
    result.changed += 1;
    result.movedEntries += removed;
    result.perApplication.push({ id: row.id, before, after, moved: removed });
  }

  return result;
}
