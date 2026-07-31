// Real-option matching for selects, radio groups and checkbox groups.
//
// The pre-drafted screening answers are prose ("Yes, for any employer"); the
// form offers a fixed, employer-specific option list ("Yes", "No",
// "I am authorized to work for any employer in the U.S."). This module maps
// one to the other DETERMINISTICALLY where it can, so an agent call is only
// needed for genuinely odd option sets, and a wrong guess is never made:
// no match → the caller parks the task with the real options attached.
//
// The synonym table lives here (server code) on purpose — the profile skill
// file 08-application-forms.md is user-owned content and is never rewritten.

export interface FieldOption {
  /** Submit value (select option value / radio input value). */
  value: string;
  /** What the human sees. */
  label: string;
}

export type MatchVia = 'exact' | 'normalized' | 'synonym' | 'numeric' | 'contains' | 'agent';

export interface OptionMatch {
  option: FieldOption;
  via: MatchVia;
}

const PLACEHOLDER_RE = /^(--+|select|choose|please\s|pick\s|-\s*select)/i;

export function isPlaceholderOption(o: FieldOption): boolean {
  const label = o.label.trim();
  return label === '' || PLACEHOLDER_RE.test(label);
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical answer classes. Every entry is a list of phrases that mean the same
 * thing on an application form; a match on either side (answer or option) puts
 * both in the same class.
 */
const SYNONYM_CLASSES: { id: string; phrases: RegExp[] }[] = [
  {
    id: 'decline',
    phrases: [
      /^prefer not to (say|answer|disclose|respond)/,
      /^i (do not|dont|don t) wish to (answer|disclose|self identify)/,
      /^decline to (self identify|answer|disclose|state)/,
      /^i (do not|dont|don t) wish to provide/,
      /^choose not to (disclose|identify)/,
      /^not (specified|disclosed)$/,
      /^no answer$/,
      /^i (do not|dont|don t) want to answer/,
    ],
  },
  {
    id: 'yes',
    phrases: [
      /^yes\b/,
      /^y$/,
      /^true$/,
      /^i am authoriz/,
      /^authorized\b/,
      /^yes i (am|will|do|have)\b/,
    ],
  },
  {
    id: 'no',
    phrases: [/^no\b/, /^n$/, /^false$/, /^i am not\b/, /^not authoriz/, /^no i (am not|do not|dont)\b/],
  },
  { id: 'none', phrases: [/^none\b/, /^n a$/, /^not applicable$/, /^no clearance/] },
  {
    id: 'veteran_not',
    phrases: [/^i am not a (protected )?veteran/, /^not a (protected )?veteran/, /^no i am not a veteran/],
  },
  {
    id: 'disability_no',
    phrases: [
      /^no i (do not|dont|don t) have a disability/,
      /^no i (do not|dont|don t) have a history/,
      /^i (do not|dont|don t) have a disability/,
    ],
  },
  {
    id: 'degree_bachelor',
    phrases: [/^bachelor/, /^bachelors/, /^b s\b/, /^b a\b/, /^undergraduate degree/, /^4 year degree/],
  },
  { id: 'degree_master', phrases: [/^master/, /^m s\b/, /^m a\b/, /^graduate degree/] },
  { id: 'degree_doctorate', phrases: [/^doctor/, /^ph d/, /^phd/] },
  { id: 'degree_associate', phrases: [/^associate/, /^a a\b/, /^a s\b/, /^2 year degree/] },
  { id: 'degree_highschool', phrases: [/^high school/, /^secondary school/, /^ged$/] },
];

function classOf(text: string): string | null {
  const n = normalizeText(text);
  if (!n) return null;
  for (const c of SYNONYM_CLASSES) {
    if (c.phrases.some((p) => p.test(n))) return c.id;
  }
  return null;
}

/** First number in a string ("3 years" → 3, "$95,000" → 95000). */
function firstNumber(text: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(text.replace(/\s/g, ''));
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Does an option label describe a range that contains `n`? ("1-3 years", "5+") */
function bucketContains(label: string, n: number): boolean {
  // Light normalization only: "+" and "-" carry the range meaning here.
  const text = label.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const range = /^(\d+)\s*(?:-|to)\s*(\d+)/.exec(text);
  if (range?.[1] && range[2]) return n >= Number(range[1]) && n <= Number(range[2]);
  const plus = /^(\d+)\s*(?:\+|or more|and above|and up|or greater)/.exec(text);
  if (plus?.[1]) return n >= Number(plus[1]);
  const less = /^(?:less than|under|fewer than)\s*(\d+)/.exec(text);
  if (less?.[1]) return n < Number(less[1]);
  const exact = /^(\d+)\s*(?:years?|yrs?)?$/.exec(text);
  if (exact?.[1]) return n === Number(exact[1]);
  return false;
}

/**
 * Deterministic answer → legal option mapping.
 * exact → normalized → synonym class → numeric bucket → containment.
 * Returns null when nothing is confident enough (caller escalates).
 */
export function matchOption(options: FieldOption[], answer: string): OptionMatch | null {
  const real = options.filter((o) => !isPlaceholderOption(o));
  const wanted = answer.trim();
  if (!wanted || real.length === 0) return null;

  // 1. exact (label or value, case-insensitive)
  const exact = real.find(
    (o) => o.label.trim().toLowerCase() === wanted.toLowerCase() || o.value.trim().toLowerCase() === wanted.toLowerCase(),
  );
  if (exact) return { option: exact, via: 'exact' };

  // 2. punctuation-insensitive equality
  const nWanted = normalizeText(wanted);
  const normalized = real.find((o) => normalizeText(o.label) === nWanted || normalizeText(o.value) === nWanted);
  if (normalized) return { option: normalized, via: 'normalized' };

  // 3. synonym class (yes/no, decline-to-answer, degree levels…)
  const wantedClass = classOf(wanted);
  if (wantedClass) {
    const hits = real.filter((o) => classOf(o.label) === wantedClass || classOf(o.value) === wantedClass);
    if (hits.length === 1) return { option: hits[0]!, via: 'synonym' };
    if (hits.length > 1) {
      // Prefer the shortest label — "Yes" over "Yes, with conditions".
      const best = [...hits].sort((a, b) => a.label.length - b.label.length)[0]!;
      return { option: best, via: 'synonym' };
    }
  }

  // 4. numeric buckets (years of experience, salary bands)
  const n = firstNumber(wanted);
  if (n != null) {
    const bucket = real.find((o) => bucketContains(o.label, n));
    if (bucket) return { option: bucket, via: 'numeric' };
  }

  // 5. containment, guarded so short answers can never match by accident
  if (nWanted.length >= 4) {
    const contains = real.filter((o) => {
      const nl = normalizeText(o.label);
      return nl.length >= 4 && (nl.startsWith(nWanted) || nWanted.startsWith(nl));
    });
    if (contains.length === 1) return { option: contains[0]!, via: 'contains' };
  }
  return null;
}

/** Prompt for the last-resort agent pick. The model MUST choose or say none. */
export function buildOptionPrompt(question: string, answer: string, options: FieldOption[]): string {
  const list = options.map((o, i) => `${i}: ${o.label}`).join('\n');
  return [
    'You map ONE pre-approved candidate answer onto ONE option of a job',
    'application form field. You never invent an answer and never pick an option',
    'that changes the meaning of the candidate answer.',
    '',
    `FORM QUESTION: ${question}`,
    `CANDIDATE ANSWER (already approved by the candidate): ${answer}`,
    '',
    'OPTIONS (choose by index):',
    list,
    '',
    'Rules:',
    '- Pick the index whose meaning is the same as the candidate answer.',
    '- If no option preserves the meaning, return {"index": null}. That is a',
    '  correct and expected outcome; a human will finish the field.',
    '- Never pick "Yes" for a "No" answer or vice versa.',
    '',
    'Reply with a single JSON object and nothing else: { "index": number | null }',
  ].join('\n');
}
