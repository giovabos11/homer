// Screening-question resolution (FR-9).
//
// Resolution order for every screening question:
//   1. STANDING ANSWER  — what the user answered once in the dashboard.
//   2. PROFILE RULE     — the "Candidate screening defaults" table parsed at
//                         runtime from 08-application-forms.md (USER-OWNED
//                         content; this file only ever reads it, PRD §9).
//   3. FLAGGED          — a structured { status: 'needs_user', … } marker.
//                         Never a guess, never the literal string that used to
//                         leak into the review modal and the pre-staged data.
//
// Rows whose default answer is "**Do not answer.**…" are the ones the user must
// supply; a standing answer for the same topic promotes them to resolved.
import type { NeedsUserAnswer, ScreeningAnswerValue, StandingAnswerKey, StandingAnswers } from '@shared/types';
import { LEGACY_FLAGGED_ANSWER, isNeedsUserAnswer } from '@shared/types';
import { readRepoFile } from '../agent/prompts';
import { STANDING_ANSWER_DEFAULTS, standingValue } from './standing';

/** Legacy sentinel — still written by nothing, still READ from old rows. */
export const FLAGGED_FOR_USER = LEGACY_FLAGGED_ANSWER;

export interface ScreeningDefault {
  question: string;
  answer: string;
  /** true → never auto-answer; surface to the user (salary, start date, citizenship…). */
  flagged: boolean;
  /** Structured marker carried alongside, when flagged. */
  needsUser?: NeedsUserAnswer;
}

/** Parse the "| Question | Default answer |" markdown table from 08-application-forms.md. */
export function loadScreeningDefaults(repoRoot: string): ScreeningDefault[] {
  const md = readRepoFile(repoRoot, '.claude/skills/job-application-assistant/08-application-forms.md', 60000);
  const out: ScreeningDefault[] = [];
  if (!md) return out;
  const section = md.split(/^##\s+Candidate screening defaults.*$/m)[1] ?? '';
  for (const line of section.split(/\r?\n/)) {
    const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const question = (m[1] ?? '').replace(/\*\*/g, '').trim();
    const rawAnswer = (m[2] ?? '').trim();
    if (!question || /^-+$/.test(question) || /^question$/i.test(question)) continue;
    const flagged = /^\*\*do not answer/i.test(rawAnswer) || /flag (it |the question )?to/i.test(rawAnswer);
    const answer = flagged ? FLAGGED_FOR_USER : rawAnswer.replace(/\*\*/g, '').trim();
    out.push({ question, answer, flagged });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Standing-answer topics — the mapping table the resolution logic runs on.
// (08-application-forms.md is user-owned content and is never rewritten from
// here; this table lives in server code by design.)
// ---------------------------------------------------------------------------

export interface StandingTopic {
  key: StandingAnswerKey;
  /** Question text used when the topic has no row in the defaults table. */
  question: string;
  /** Matches a defaults-table row or an arbitrary form question. */
  re: RegExp;
  hint: string;
}

/** Order matters: the most specific phrasings come first. */
export const STANDING_TOPICS: StandingTopic[] = [
  {
    key: 'salaryExpectation',
    question: 'Salary expectations',
    re: /salary|compensation|desired\s+pay|pay\s+(rate|range|expectation)|expected\s+(pay|earnings)|rate\s+of\s+pay/i,
    hint: 'Homer never invents a number. Set a standing answer (e.g. "Open, targeting market rate for the role").',
  },
  {
    key: 'noticePeriod',
    question: 'Notice period',
    re: /notice\s+period|how\s+much\s+notice/i,
    hint: 'How much notice you owe your current commitments.',
  },
  {
    key: 'earliestStartDate',
    question: 'Earliest start date',
    re: /start\s+date|when\s+(can|could)\s+you\s+start|earliest.*(start|availab)|availability\s+to\s+start/i,
    hint: 'The earliest date you could actually start. A month ("Immediately", "Two weeks from offer") is fine.',
  },
  {
    key: 'securityClearance',
    question: 'Security clearance',
    re: /security\s+clearance|clearance\s+(level|status)|\bts\/sci\b/i,
    hint: 'Clearance you actually hold. "None" is a valid, truthful answer.',
  },
  {
    key: 'citizenshipStatus',
    question: 'Citizenship status',
    re: /citizen|national(ity)?\s+status|permanent\s+resident|green\s+card/i,
    hint: 'Your own words. Homer will never claim or infer a citizenship you have not stated.',
  },
  {
    key: 'requiresSponsorship',
    question: 'Will you now or in the future require sponsorship?',
    re: /sponsor(ship)?|visa\s+sponsor/i,
    hint: 'Whether an employer would have to sponsor a visa for you.',
  },
  {
    key: 'willingToRelocate',
    question: 'Are you willing to relocate?',
    re: /relocat/i,
    hint: 'Whether you would move for the role, and any limits.',
  },
  {
    key: 'eeoRace',
    question: 'Race / ethnicity (voluntary self-identification)',
    re: /\b(race|ethnicit|hispanic|latino)\b/i,
    hint: 'Voluntary EEO question. "Prefer not to say" is always acceptable.',
  },
  {
    key: 'eeoGender',
    question: 'Gender (voluntary self-identification)',
    re: /\b(gender|sex)\b/i,
    hint: 'Voluntary EEO question. "Prefer not to say" is always acceptable.',
  },
  {
    key: 'eeoVeteran',
    question: 'Veteran status (voluntary self-identification)',
    re: /veteran|military\s+service|protected\s+veteran/i,
    hint: 'Voluntary EEO question. "Prefer not to say" is always acceptable.',
  },
  {
    key: 'eeoDisability',
    question: 'Disability status (voluntary self-identification)',
    re: /disabilit|\bada\b/i,
    hint: 'Voluntary EEO question. "Prefer not to say" is always acceptable.',
  },
  {
    key: 'preferredPronouns',
    question: 'Preferred pronouns',
    re: /pronoun/i,
    hint: 'Optional. Left blank unless you set it.',
  },
  {
    key: 'referencesAvailable',
    question: 'References',
    re: /\breferences?\b/i,
    hint: 'What you want said about references (e.g. "Available on request").',
  },
];

/**
 * Every standing answer this question touches. Usually one; the defaults table
 * has one combined row ("Security clearance / citizenship questions") that
 * needs both before it can be answered truthfully.
 */
export function standingKeysForQuestion(question: string): StandingAnswerKey[] {
  return STANDING_TOPICS.filter((t) => t.re.test(question)).map((t) => t.key);
}

/** Which standing answer (if any) settles this question forever. */
export function standingKeyForQuestion(question: string): StandingAnswerKey | null {
  return standingKeysForQuestion(question)[0] ?? null;
}

function topicFor(key: StandingAnswerKey): StandingTopic | undefined {
  return STANDING_TOPICS.find((t) => t.key === key);
}

function needsUser(question: string, key: StandingAnswerKey | null, suggestion?: string): NeedsUserAnswer {
  const topic = key ? topicFor(key) : undefined;
  return {
    status: 'needs_user',
    question,
    hint: topic?.hint ?? 'Homer has no grounded answer for this and will not invent one.',
    ...(suggestion ? { suggestion } : {}),
    ...(key ? { standingKey: key } : {}),
  };
}

/**
 * The answers map for an application: standing answers → profile rules →
 * structured needs-user markers. Standing answers that no defaults-table row
 * covers (EEO, pronouns, references) are appended only when they have a value,
 * so an unset optional never blocks an application.
 */
export function resolveScreeningAnswers(
  repoRoot: string,
  standing: StandingAnswers = STANDING_ANSWER_DEFAULTS,
): Record<string, ScreeningAnswerValue> {
  const out: Record<string, ScreeningAnswerValue> = {};

  for (const d of loadScreeningDefaults(repoRoot)) {
    const keys = standingKeysForQuestion(d.question);
    const values = keys.map((k) => standingValue(standing, k));
    // A combined question ("clearance / citizenship") only resolves once every
    // topic it asks about has a standing answer — half an answer is a wrong one.
    if (keys.length > 0 && values.every((v) => v !== '')) {
      out[d.question] = values.join('; '); // 1. standing wins
      continue;
    }
    if (!d.flagged) {
      out[d.question] = d.answer; // 2. profile rule
      continue;
    }
    const missing = keys.find((k) => standingValue(standing, k) === '') ?? keys[0] ?? null;
    out[d.question] = needsUser(d.question, missing, salarySuggestion(missing, standing)); // 3. flagged
  }

  // Standing answers with no row in the defaults table (EEO, pronouns,
  // references, notice period, citizenship on its own) — only when answered,
  // so an unset optional can never block an application.
  for (const topic of STANDING_TOPICS) {
    const value = standingValue(standing, topic.key);
    if (value) out[topic.question] = value;
  }
  return out;
}

/** A numeric floor is a hint, never an auto-answer. */
function salarySuggestion(key: StandingAnswerKey | null, standing: StandingAnswers): string | undefined {
  if (key !== 'salaryExpectation') return undefined;
  const floor = standing.salaryMinAcceptable;
  if (floor == null || !Number.isFinite(floor)) return undefined;
  return `At least ${Math.round(floor).toLocaleString('en-US')} per year`;
}

/** Legacy answers map (plain strings, "FLAGGED_FOR_USER" sentinel) → structured. */
export function normalizeAnswers(
  raw: Record<string, unknown> | null | undefined,
): Record<string, ScreeningAnswerValue> {
  const out: Record<string, ScreeningAnswerValue> = {};
  if (!raw) return out;
  for (const [question, value] of Object.entries(raw)) {
    if (isNeedsUserAnswer(value as ScreeningAnswerValue)) {
      out[question] = value as NeedsUserAnswer;
      continue;
    }
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (text === FLAGGED_FOR_USER || /^flagged\b/i.test(text)) {
      out[question] = needsUser(question, standingKeyForQuestion(question));
      continue;
    }
    out[question] = text;
  }
  return out;
}

/** Questions still waiting on the user. */
export function unresolvedQuestions(answers: Record<string, ScreeningAnswerValue> | null | undefined): string[] {
  if (!answers) return [];
  return Object.entries(answers)
    .filter(([, v]) => isNeedsUserAnswer(v))
    .map(([q]) => q);
}

/** True when nothing in the map still needs the user (empty map counts as resolved). */
export function answersResolved(answers: Record<string, ScreeningAnswerValue> | null | undefined): boolean {
  return unresolvedQuestions(answers).length === 0;
}

const NORMALIZE_RE = /[^a-z0-9 ]+/g;

function normalize(text: string): string {
  return text.toLowerCase().replace(NORMALIZE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Question-topic patterns → the matching defaults-table row. Order matters. */
const TOPIC_PATTERNS: { re: RegExp; key: RegExp }[] = [
  { re: /sponsor(ship)?|visa\s+sponsor/i, key: /sponsorship/i },
  { re: /authoriz|legally\s+(able|allowed)\s+to\s+work|work\s+permit|right\s+to\s+work/i, key: /authorized to work/i },
  { re: /relocat/i, key: /relocate/i },
  { re: /remote|hybrid|on-?site/i, key: /remote/i },
  { re: /full[\s-]?time|availability\s+for\s+full/i, key: /full-?time/i },
  { re: /18\s+years|over\s+18|age\s+of\s+18/i, key: /18 years/i },
  { re: /salary|compensation|pay\s+(rate|range|expectation)|desired\s+pay/i, key: /salary/i },
  { re: /notice\s+period/i, key: /notice period/i },
  { re: /start\s+date|when\s+(can|could)\s+you\s+start|earliest.*start/i, key: /start date/i },
  { re: /security\s+clearance|clearance\s+level/i, key: /^security clearance$/i },
  { re: /citizen|permanent\s+resident|green\s+card/i, key: /^citizenship status$/i },
  { re: /\b(race|ethnicit|hispanic|latino)\b/i, key: /race|ethnicit/i },
  { re: /\b(gender|sex)\b/i, key: /gender/i },
  { re: /veteran|protected\s+veteran|military\s+service/i, key: /veteran/i },
  { re: /disabilit/i, key: /disabilit/i },
  { re: /pronoun/i, key: /pronoun/i },
  { re: /\breferences?\b/i, key: /reference/i },
  { re: /language/i, key: /language/i },
  { re: /education|degree|qualification/i, key: /education/i },
  { re: /phone|mobile/i, key: /phone/i },
  { re: /e-?mail/i, key: /email|phone/i },
  { re: /\b(city|location|address|where.*based|where.*located)\b/i, key: /^location$/i },
];

/**
 * Match an arbitrary form question to a screening default.
 * Returns null when no default covers it (caller flags to the user).
 */
export function matchScreeningAnswer(question: string, defaults: ScreeningDefault[]): ScreeningDefault | null {
  const nq = normalize(question);
  if (!nq) return null;
  // Exact / substring match against the defaults table first.
  for (const d of defaults) {
    const nd = normalize(d.question);
    if (nd && (nq === nd || nq.includes(nd) || nd.includes(nq))) return d;
  }
  // Topic-pattern match second.
  for (const t of TOPIC_PATTERNS) {
    if (t.re.test(question)) {
      const d = defaults.find((x) => t.key.test(x.question));
      if (d) return d;
    }
  }
  return null;
}

/** Yes/no reduction for radio groups and selects ("Yes, for any employer" → yes). */
export function yesNo(answer: string): 'yes' | 'no' | null {
  if (/^yes\b/i.test(answer)) return 'yes';
  if (/^no\b/i.test(answer)) return 'no';
  return null;
}

/** Answers map (any vintage) → the ScreeningDefault[] shape the driver plans with. */
export function defaultsFromAnswers(answers: Record<string, ScreeningAnswerValue>): ScreeningDefault[] {
  return Object.entries(normalizeAnswers(answers)).map(([question, value]) => {
    if (isNeedsUserAnswer(value)) {
      return { question, answer: FLAGGED_FOR_USER, flagged: true, needsUser: value };
    }
    return { question, answer: value, flagged: false };
  });
}

/** Screening answers with no standing store (kept for callers that predate it). */
export function screeningAnswers(repoRoot: string): Record<string, ScreeningAnswerValue> {
  return resolveScreeningAnswers(repoRoot);
}
