// Legitimacy structural signals (FR-7). Computed in code BEFORE any agent call
// so the scam score never depends solely on model judgment. The score worker
// merges these with the agent's web-verification verdict (worst verdict wins).
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { LegitVerdict } from '@shared/types';
import type { Db } from '../db/client';
import { jobs } from '../db/schema';

type JobRow = typeof jobs.$inferSelect;

export interface StructuralSignal {
  code: string;
  reason: string;
  /** Classic-scam keyword class (metadata only — structural signals alone never exceed 'suspicious'). */
  hard: boolean;
}

/**
 * Benign HR phrases that must never trip the scam keyword patterns
 * ("background checks", "reference checks", "direct deposit" are normal
 * benefits/process language — a Duolingo posting was quarantined because its
 * own anti-fraud disclaimer said "we'll never ask you to deposit a check").
 */
const BENIGN_PHRASES_RE = /\b(?:background|reference|credit)\s+checks?\b|\bdirect\s+deposit\b/gi;

/** Keywords that mark classic job-scam language. */
const HARD_KEYWORD_PATTERNS: { re: RegExp; code: string; reason: string }[] = [
  { re: /pay[\s-]*to[\s-]*apply|application\s+fee|registration\s+fee|training\s+fee|pay\s+for\s+(your\s+)?training/i, code: 'pay_to_apply', reason: 'Posting asks the applicant to pay a fee (pay-to-apply language)' },
  { re: /wire\s+transfer|western\s+union|moneygram/i, code: 'wire_transfer', reason: 'Posting mentions wire transfers (classic advance-fee scam signal)' },
  // Employer-task phrasing only: "cash/deposit checks … for/on behalf of …".
  // Bare mentions ("we'll never ask you to deposit a check") no longer match.
  { re: /\b(?:cash|deposit)(?:ing)?\s+(?:a\s+|the\s+)?(?:checks?|money\s+orders?)\b[\s\S]{0,40}?\b(?:for|on\s+behalf\s+of)\b/i, code: 'check_cashing', reason: 'Posting asks the applicant to cash or deposit checks for the employer' },
];

const SOFT_KEYWORD_PATTERNS: { re: RegExp; code: string; reason: string }[] = [
  { re: /no\s+experience\s+(needed|necessary|required)[\s\S]{0,120}?(six\s*figures|\$\s?1\d{2},?\d{3}|100k|six-figure)/i, code: 'no_experience_six_figures', reason: '"No experience needed" paired with six-figure pay' },
  { re: /(six\s*figures|six-figure)[\s\S]{0,120}?no\s+experience\s+(needed|necessary|required)/i, code: 'six_figures_no_experience', reason: 'Six-figure pay paired with "no experience needed"' },
  { re: /quick\s+money|earn\s+\$\d+\s*(per|a)\s*(day|hour)\s+from\s+home|unlimited\s+earning/i, code: 'get_rich_quick', reason: 'Get-rich-quick earnings language' },
  { re: /contact\s+(us|me)\s+(via|on|through)\s+(telegram|whatsapp)/i, code: 'chat_app_contact', reason: 'Recruiting exclusively via Telegram/WhatsApp' },
];

const FREE_MAIL_RE = /[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|aol|proton|icloud)\.[a-z.]+/i;

/** Normalize a description for duplicate detection across companies. */
export function descriptionFingerprint(descriptionMd: string): string {
  return descriptionMd.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

export function keywordSignals(descriptionMd: string): StructuralSignal[] {
  // Scrub benign HR phrasing first so scam patterns can never match inside it.
  const text = descriptionMd.replace(BENIGN_PHRASES_RE, ' ');
  const out: StructuralSignal[] = [];
  for (const p of HARD_KEYWORD_PATTERNS) {
    if (p.re.test(text)) out.push({ code: p.code, reason: p.reason, hard: true });
  }
  for (const p of SOFT_KEYWORD_PATTERNS) {
    if (p.re.test(text)) out.push({ code: p.code, reason: p.reason, hard: false });
  }
  return out;
}

export function freeMailSignal(descriptionMd: string): StructuralSignal | null {
  const m = FREE_MAIL_RE.exec(descriptionMd);
  if (!m) return null;
  return {
    code: 'free_mail_contact',
    reason: `Contact address uses a free mail provider (${m[0]})`,
    hard: false,
  };
}

/** salary far outside band: max > 3x the source's median posted max. */
export function salaryOutlierSignal(db: Db, job: Pick<JobRow, 'id' | 'source' | 'salaryMax'>): StructuralSignal | null {
  if (job.salaryMax == null) return null;
  const rows = db
    .select({ salaryMax: jobs.salaryMax })
    .from(jobs)
    .where(and(eq(jobs.source, job.source), isNotNull(jobs.salaryMax), ne(jobs.id, job.id)))
    .all();
  const values = rows.map((r) => r.salaryMax!).sort((a, b) => a - b);
  if (values.length < 5) return null; // not enough data for a meaningful median
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  if (median > 0 && job.salaryMax > 3 * median) {
    return {
      code: 'salary_outlier',
      reason: `Posted salary max ${job.salaryMax} is more than 3x the ${job.source} median (${Math.round(median)})`,
      hard: false,
    };
  }
  return null;
}

/** Same description text posted under 2+ different companies (mass-posting). */
export function duplicateDescriptionSignal(db: Db, job: Pick<JobRow, 'id' | 'company' | 'descriptionMd'>): StructuralSignal | null {
  if (!job.descriptionMd || job.descriptionMd.length < 200) return null;
  const fp = descriptionFingerprint(job.descriptionMd);
  const candidates = db
    .select({ id: jobs.id, company: jobs.company, descriptionMd: jobs.descriptionMd })
    .from(jobs)
    .where(and(ne(jobs.id, job.id), isNotNull(jobs.descriptionMd), sql`length(${jobs.descriptionMd}) >= 200`))
    .all();
  const otherCompanies = new Set<string>();
  for (const c of candidates) {
    if (c.company.toLowerCase() === job.company.toLowerCase()) continue;
    if (c.descriptionMd && descriptionFingerprint(c.descriptionMd) === fp) otherCompanies.add(c.company);
  }
  if (otherCompanies.size >= 1) {
    return {
      code: 'mass_posting_duplicate',
      reason: `Identical description also posted by: ${[...otherCompanies].slice(0, 3).join(', ')}`,
      hard: false,
    };
  }
  return null;
}

export function structuralSignals(db: Db, job: JobRow): StructuralSignal[] {
  const out: StructuralSignal[] = [];
  const desc = job.descriptionMd ?? '';
  out.push(...keywordSignals(desc));
  const free = freeMailSignal(desc);
  if (free) out.push(free);
  const salary = salaryOutlierSignal(db, job);
  if (salary) out.push(salary);
  const dup = duplicateDescriptionSignal(db, job);
  if (dup) out.push(dup);
  return out;
}

const VERDICT_RANK: Record<LegitVerdict, number> = { unchecked: 0, legit: 1, suspicious: 2, scam: 3 };

/**
 * Structural signals alone cap at 'suspicious' — a 'scam' verdict requires the
 * agent's web verification to concur (the worst-verdict merge upgrades it when
 * the agent also says scam). Keyword heuristics quarantining real postings on
 * their own proved too false-positive-prone.
 */
export function verdictFromSignals(signals: StructuralSignal[]): LegitVerdict {
  return signals.length > 0 ? 'suspicious' : 'legit';
}

/** Worst verdict wins when merging structural + agent verdicts. */
export function mergeVerdicts(a: LegitVerdict, b: LegitVerdict): LegitVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}
