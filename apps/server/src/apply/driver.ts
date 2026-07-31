// Apply-driver seam (FR-9, FR-25, FR-30, PRD D5). Two implementations:
// PlaywrightApplyDriver (default, headed persistent Chromium profile) and
// ChromeApplyDriver (Claude in Chrome — interactive only, always parks).
import crypto from 'node:crypto';
import type { ParkReason, ScreeningAnswerValue } from '@shared/types';
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
 *
 * `reason` is an explicit discriminator, not something to be re-derived from the
 * prompt text. A dead posting once surfaced as "a Google reCAPTCHA is blocking
 * mintmcp" purely because the error page's CSS mentioned `.grecaptcha-badge`;
 * carrying the reason means the needs-attention card can never invent a cause.
 */
export class ApplyBlocked extends Error {
  constructor(
    public readonly prompt: string,
    public readonly screenshots: ApplyScreenshot[] = [],
    /** Questions whose real option list the dashboard can render as buttons. */
    public readonly choices: BlockedChoice[] = [],
    /** Why this parked — surfaced verbatim in the task payload and the UI. */
    public readonly reason: ParkReason = 'driver_manual',
  ) {
    super(prompt);
  }
}

// ---------- captcha / verification detection (pure, unit-testable) ----------

/**
 * A REAL captcha widget: the vendor's script/iframe/API host, or the container
 * element their embed snippet creates. Deliberately anchored to markup, not to
 * the bare product name — `.grecaptcha-badge { visibility: hidden }` in a
 * stylesheet is not a captcha, and treating it as one is exactly how a dead
 * Ashby posting got reported as a reCAPTCHA wall.
 */
const CAPTCHA_WIDGETS: { re: RegExp; what: string }[] = [
  {
    // v2 challenge only: the explicit container, the anchor/bframe challenge
    // iframes, or an explicit render() call. The bare `recaptcha/api.js` script
    // and `grecaptcha.execute()` are reCAPTCHA v3 — invisible, scored, and NOT a
    // wall, so they must not park a task that could have submitted fine.
    re: /class=["'][^"']*\bg-recaptcha\b[^"']*["']|(?:src|href)=["'][^"']*recaptcha\/api2\/(?:anchor|bframe)[^"']*["']|grecaptcha\.render\s*\(/i,
    what: 'Google reCAPTCHA',
  },
  {
    re: /class=["'][^"']*\bh-captcha\b[^"']*["']|(?:src|href)=["'][^"']*hcaptcha\.com\/captcha\/[^"']*["']|hcaptcha\.render\s*\(/i,
    what: 'hCaptcha',
  },
  {
    re: /class=["'][^"']*\bcf-turnstile\b[^"']*["']|(?:src|href)=["'][^"']*challenges\.cloudflare\.com\/[^"']*["']|turnstile\.render\s*\(/i,
    what: 'Cloudflare Turnstile',
  },
];

/** Interstitial wording that is a challenge in its own right (no widget needed). */
const CHALLENGE_TEXT_RE =
  /verify\s+(that\s+)?you\s+are\s+(a\s+)?human|i('|’)?m\s+not\s+a\s+robot|are\s+you\s+a\s+robot|checking\s+your\s+browser\s+before\s+accessing/i;

/** A form surface the captcha could plausibly be guarding. */
export function hasFormContext(html: string): boolean {
  return /<form\b/i.test(html) || /<input\b/i.test(html) || /<textarea\b/i.test(html) || /<select\b/i.test(html);
}

/**
 * Detect a captcha / verification wall in page HTML. Returns a description or
 * null. NEVER auto-solved (PRD §8).
 *
 * A widget only counts when BOTH hold:
 *   1. it is a genuine blocking widget (vendor container class, challenge
 *      iframe, or an explicit render call), AND
 *   2. the page has a form context — a captcha guarding nothing is page furniture.
 * That pair is what a dead Ashby posting failed: its error shell carries
 * `.grecaptcha-badge { visibility: hidden }` inside a <style> block and has no
 * form at all, yet the old substring match reported "a Google reCAPTCHA is
 * blocking mintmcp" and sent the user off to solve nothing.
 *
 * Explicit interstitial wording ("verify you are human", Cloudflare's browser
 * check) is a wall on its own and does not need a form.
 *
 * Liveness runs BEFORE this in every caller, so "dead posting" always wins.
 */
export function detectCaptcha(html: string): string | null {
  if (hasFormContext(html)) {
    for (const p of CAPTCHA_WIDGETS) {
      if (p.re.test(html)) return p.what;
    }
  }
  if (CHALLENGE_TEXT_RE.test(html)) return 'human-verification challenge';
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
