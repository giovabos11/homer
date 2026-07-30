// Screening-question defaults (FR-9), parsed at runtime from the profile skill
// file 08-application-forms.md ("Candidate screening defaults" table) so no
// personal values are hardcoded in the server (PRD §9 portability rule).
//
// Rows whose default answer is "**Do not answer.**…" become FLAGGED_FOR_USER —
// the pipeline surfaces them to the user and never invents a value.
import { readRepoFile } from '../agent/prompts';

export const FLAGGED_FOR_USER = 'FLAGGED_FOR_USER';

export interface ScreeningDefault {
  question: string;
  answer: string;
  /** true → never auto-answer; surface to the user (salary, start date, citizenship…). */
  flagged: boolean;
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

/** Answers map for the application record / form filling (flagged → FLAGGED_FOR_USER). */
export function screeningAnswers(repoRoot: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const d of loadScreeningDefaults(repoRoot)) answers[d.question] = d.answer;
  return answers;
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
  { re: /start\s+date|when\s+(can|could)\s+you\s+start|earliest.*start|notice\s+period/i, key: /start date/i },
  { re: /citizen|security\s+clearance|clearance\s+level/i, key: /clearance|citizenship/i },
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
