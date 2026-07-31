// Apply-driver seam (FR-9, FR-25, FR-30, PRD D5). Two implementations:
// PlaywrightApplyDriver (default, headed persistent Chromium profile) and
// ChromeApplyDriver (Claude in Chrome — interactive only, always parks).
import crypto from 'node:crypto';
import type { ScreeningAnswerValue } from '@shared/types';
import type { AgentRunner } from '../agent/types';
import type { FieldOption } from './option-match';

export type AtsKind = 'greenhouse' | 'lever' | 'ashby' | 'generic';

export interface ApplyTarget {
  url: string;
  company: string;
  title: string;
}

export interface ApplyProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  links: { label: string; url: string }[];
  resumePath: string | null;
  coverLetterPath: string | null;
  /** Drafted cover-letter text for "paste your cover letter" textareas. */
  coverLetterText?: string;
  /**
   * Pre-drafted screening answers: standing answers → profile rules →
   * structured needs-user markers (never invented values).
   */
  answers: Record<string, ScreeningAnswerValue>;
}

/**
 * A form question the driver refused to guess, WITH the field's real options
 * so the dashboard can offer them as one-click choices (FR-25).
 */
export interface BlockedChoice {
  question: string;
  options: FieldOption[];
  /** The resolved answer that could not be mapped onto those options. */
  answer?: string;
}

export interface ApplyScreenshot {
  stage: 'before-fill' | 'after-fill' | 'confirmation' | 'parked';
  path: string;
}

export interface ApplyOutcome {
  submitted: boolean;
  ats: AtsKind;
  confirmationText: string | null;
  screenshots: ApplyScreenshot[];
  filledFields: Record<string, string>;
  answersUsed: Record<string, string>;
}

export interface ApplyCredentialStore {
  lookup(site: string): Promise<{ username: string; password: string } | null>;
  save(site: string, username: string, password: string): Promise<void>;
}

export interface ApplyRunArgs {
  target: ApplyTarget;
  profile: ApplyProfile;
  /** Directory for screenshots/audit files of this run. */
  auditDir: string;
  /** Final submit only happens when true (gate approval upstream). */
  submit: boolean;
  credentials: ApplyCredentialStore;
  /** Agent used to draft grounded answers for unknown free-text questions. */
  runner: AgentRunner;
  /** Model alias for the cheap option-matching calls (settings.modelScore tier). */
  optionModel?: string;
  timeoutMs?: number;
}

export interface ApplyDriver {
  readonly name: 'playwright' | 'chrome';
  apply(args: ApplyRunArgs): Promise<ApplyOutcome>;
  dispose(): Promise<void>;
}

/**
 * Thrown when the driver hits a wall a human must clear (captcha, login,
 * salary question, low-confidence generic form). The queue runner turns it
 * into a needs_human task; the browser context stays open for the user.
 */
export class ApplyBlocked extends Error {
  constructor(
    public readonly prompt: string,
    public readonly screenshots: ApplyScreenshot[] = [],
    /** Questions whose real option list the dashboard can render as buttons. */
    public readonly choices: BlockedChoice[] = [],
  ) {
    super(prompt);
  }
}

// ---------- captcha / verification detection (pure, unit-testable) ----------

const CAPTCHA_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /google\.com\/recaptcha|g-recaptcha|grecaptcha/i, what: 'Google reCAPTCHA' },
  { re: /hcaptcha\.com|h-captcha|hcaptcha/i, what: 'hCaptcha' },
  { re: /challenges\.cloudflare\.com|cf-turnstile|turnstile/i, what: 'Cloudflare Turnstile' },
  { re: /verify\s+(that\s+)?you\s+are\s+(a\s+)?human|i('|’)?m\s+not\s+a\s+robot|are\s+you\s+a\s+robot/i, what: 'human-verification challenge' },
];

/**
 * Detect a captcha / verification wall in page HTML (including iframe src
 * attributes). Returns a description or null. NEVER auto-solved (PRD §8).
 */
export function detectCaptcha(html: string): string | null {
  for (const p of CAPTCHA_PATTERNS) {
    if (p.re.test(html)) return p.what;
  }
  return null;
}

/** Detect ATS platform from an apply URL. */
export function detectAts(url: string): AtsKind {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generic';
  }
  if (host.endsWith('greenhouse.io')) return 'greenhouse'; // boards. / job-boards.
  if (host.endsWith('lever.co')) return 'lever'; // jobs.lever.co
  if (host.endsWith('ashbyhq.com')) return 'ashby'; // jobs.ashbyhq.com
  return 'generic';
}

/** Strong random password for ATS account auto-registration (vault-stored). */
export function generateStrongPassword(length = 20): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_+=';
  const all = upper + lower + digits + symbols;
  const pick = (set: string) => set[crypto.randomInt(set.length)]!;
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates with crypto randomness.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
