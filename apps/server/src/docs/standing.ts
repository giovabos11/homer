// Standing answers (FR-9) — the "answer once, reuse forever" store.
//
// These are the values only the candidate can supply (salary, start date,
// citizenship status, voluntary EEO). 08-application-forms.md marks them
// "do not answer" precisely because they must never be invented; this store is
// where the user answers them ONCE so the pipeline stops asking.
//
// Storage: a plain `standing_answers` key→JSON table. It is normal data — a
// `POST /api/reset` with scope 'db' wipes it (documented in CONTRACT.md), the
// same way jobs and applications are wiped. Nothing is ever auto-populated:
// an unset key stays unset and keeps its question flagged.
import { eq } from 'drizzle-orm';
import type { StandingAnswerKey, StandingAnswers } from '@shared/types';
import type { Db } from '../db/client';
import { standingAnswers } from '../db/schema';

export const STANDING_ANSWER_KEYS: StandingAnswerKey[] = [
  'salaryExpectation',
  'salaryMinAcceptable',
  'earliestStartDate',
  'noticePeriod',
  'citizenshipStatus',
  'requiresSponsorship',
  'securityClearance',
  'eeoRace',
  'eeoGender',
  'eeoVeteran',
  'eeoDisability',
  'willingToRelocate',
  'preferredPronouns',
  'referencesAvailable',
];

/**
 * Defaults. Only the voluntary EEO fields get a real default ("Prefer not to
 * say" is the neutral, always-truthful answer). Everything else starts empty —
 * an empty value means "still unknown", never "assume something".
 */
export const STANDING_ANSWER_DEFAULTS: StandingAnswers = {
  salaryExpectation: '',
  salaryMinAcceptable: null,
  earliestStartDate: '',
  noticePeriod: '',
  citizenshipStatus: '',
  requiresSponsorship: '',
  securityClearance: '',
  eeoRace: 'Prefer not to say',
  eeoGender: 'Prefer not to say',
  eeoVeteran: 'Prefer not to say',
  eeoDisability: 'Prefer not to say',
  willingToRelocate: '',
  preferredPronouns: '',
  referencesAvailable: '',
};

/** Keys the onboarding prompt nags about — without them applications stall. */
export const CRITICAL_STANDING_KEYS: StandingAnswerKey[] = [
  'salaryExpectation',
  'earliestStartDate',
  'citizenshipStatus',
];

export class StandingAnswerStore {
  constructor(private db: Db) {}

  get(): StandingAnswers {
    const rows = this.db.select().from(standingAnswers).all();
    const out = { ...STANDING_ANSWER_DEFAULTS } as Record<string, unknown>;
    for (const row of rows) {
      if (!STANDING_ANSWER_KEYS.includes(row.key as StandingAnswerKey)) continue;
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        /* corrupt row → keep the default */
      }
    }
    return out as unknown as StandingAnswers;
  }

  /** Partial patch; only known keys are written. */
  patch(partial: Partial<StandingAnswers>): StandingAnswers {
    const now = new Date().toISOString();
    for (const key of STANDING_ANSWER_KEYS) {
      if (!(key in partial)) continue;
      const value = (partial as Record<string, unknown>)[key];
      if (value === undefined) continue;
      this.db
        .insert(standingAnswers)
        .values({ key, value: JSON.stringify(value), updatedAt: now })
        .onConflictDoUpdate({ target: standingAnswers.key, set: { value: JSON.stringify(value), updatedAt: now } })
        .run();
    }
    return this.get();
  }

  /** Keys the user still has to answer before applications can run unattended. */
  missingCritical(): StandingAnswerKey[] {
    const current = this.get();
    return CRITICAL_STANDING_KEYS.filter((k) => !hasValue(current, k));
  }
}

export function hasValue(answers: StandingAnswers, key: StandingAnswerKey): boolean {
  const v = (answers as unknown as Record<string, unknown>)[key];
  if (v == null) return false;
  return String(v).trim() !== '';
}

/** Human-readable value for a standing key ('' when unset). */
export function standingValue(answers: StandingAnswers, key: StandingAnswerKey): string {
  const v = (answers as unknown as Record<string, unknown>)[key];
  if (v == null) return '';
  return String(v).trim();
}
