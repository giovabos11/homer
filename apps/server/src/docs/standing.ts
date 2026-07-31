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
import type { EnumishStandingKey, StandingAnswerKey, StandingAnswers } from '@shared/types';
import { STANDING_ANSWER_OPTIONS } from '@shared/types';
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

// ---------------------------------------------------------------------------
// Value normalization — casing must never be an error.
//
// The dashboard offers dropdowns for the enum-ish keys, but a typed value has
// to work too: "No", "no" and "NO" are the same answer, and refusing one of
// them for its capital letter is a bug, not validation.
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation, collapse whitespace — the comparison key. */
function compareKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const YES_WORDS = new Set(['yes', 'y', 'true', '1']);
const NO_WORDS = new Set(['no', 'n', 'false', '0', 'none', 'not required', 'no sponsorship required']);

/**
 * Any casing or phrasing of yes/no → the stored lowercase value.
 * '' stays '' (unset). Returns null when the value is neither, so the API can
 * answer with a real 400 instead of silently storing nonsense.
 */
export function normalizeYesNo(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return '';
  const key = compareKey(value);
  if (YES_WORDS.has(key)) return 'yes';
  if (NO_WORDS.has(key)) return 'no';
  if (/^yes\b/i.test(value)) return 'yes';
  if (/^no\b/i.test(value)) return 'no';
  return null;
}

function hasOptions(key: StandingAnswerKey): key is EnumishStandingKey {
  return key in STANDING_ANSWER_OPTIONS;
}

/**
 * Snap a typed value onto its canonical option when it matches one (ignoring
 * case and punctuation); otherwise keep what the user typed. Free text stays
 * possible everywhere except `requiresSponsorship`, which the apply driver
 * matches on and which therefore stays strictly yes/no.
 */
export function canonicalizeStandingValue(key: StandingAnswerKey, raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  if (key === 'requiresSponsorship') return normalizeYesNo(value) ?? value;
  if (!hasOptions(key)) return value;
  const wanted = compareKey(value);
  const match = (STANDING_ANSWER_OPTIONS[key] as readonly string[]).find((o) => compareKey(o) === wanted);
  return match ?? value;
}
