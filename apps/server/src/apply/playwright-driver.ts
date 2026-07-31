// PlaywrightApplyDriver (FR-9, FR-25, FR-30, PRD D5) — the default apply
// driver: headed Chromium with a persistent profile at data/browser-profile.
//
//  - Deterministic form-fill for Greenhouse / Lever / Ashby application forms
//    (profile fields, resume/cover uploads, screening defaults from
//    08-application-forms.md carried in profile.answers).
//  - Screening questions whose default is FLAGGED_FOR_USER (salary, start date,
//    citizenship) and unknown required questions → ApplyBlocked (needs_human)
//    with the pre-staged data listed; nothing is ever invented.
//  - Captcha / verification walls (reCAPTCHA, hCaptcha, Turnstile iframes,
//    verify-human text) → ApplyBlocked. NEVER auto-solved (PRD §8).
//  - Login walls → vault credential lookup; no credential → ApplyBlocked.
//    Sign-up forms auto-register with the profile email + a vault-generated
//    strong password.
//  - Generic (non-big-3) forms → agent-assisted field mapping; low confidence
//    or unanswerable required fields → ApplyBlocked with pre-staged data.
//  - Final submit happens ONLY when args.submit is true (gate approval
//    upstream). Audit screenshots: before-fill / after-fill / confirmation.
//  - On ApplyBlocked the browser context is left open for the user (FR-25);
//    dispose() is the caller's decision.
//
// TESTING SAFETY: automated tests exercise this driver against local fixture
// forms (test/fixtures/*.html via file://) only — never against a real
// employer. Real ATS pages may be loaded read-only for selector validation,
// but a test must never click submit on one.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { fenceUntrusted, strictJsonFooter } from '../agent/prompts';
import { FLAGGED_FOR_USER, defaultsFromAnswers, matchScreeningAnswer, type ScreeningDefault } from '../docs/screening';
import { buildOptionPrompt, matchOption, type FieldOption } from './option-match';
import {
  ApplyBlocked,
  detectAts,
  detectCaptcha,
  generateStrongPassword,
  type ApplyDriver,
  type ApplyOutcome,
  type ApplyProfile,
  type ApplyRunArgs,
  type ApplyScreenshot,
  type AtsKind,
  type BlockedChoice,
} from './driver';

type Page = import('playwright').Page;
type BrowserContext = import('playwright').BrowserContext;

// ---------- field model (serializable, unit-testable) ----------

export interface FieldDescriptor {
  index: number;
  tag: 'input' | 'textarea' | 'select';
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  /** Nearest field-container text — the "question" for screening fields. */
  contextText: string;
  required: boolean;
  visible: boolean;
  value: string;
  /** Visible option labels (legacy shape). */
  options: string[];
  /** Real option set with submit values — what option matching actually runs on. */
  optionSet?: FieldOption[];
}

export interface FillAction {
  index: number;
  kind: 'fill' | 'select' | 'check' | 'upload-resume' | 'upload-cover';
  value: string;
  label: string;
}

export interface FillBlocker {
  question: string;
  reason: 'salary' | 'start_date' | 'flagged' | 'unknown' | 'no_option_match';
  /** Real, legal options for a select / radio / checkbox group. */
  options?: FieldOption[];
  /** The resolved answer that could not be mapped onto those options. */
  answer?: string;
  /** Field (or radio-group leader) index — how an agent/human pick gets applied. */
  index?: number;
  /** For radio/checkbox groups: the input index behind each option, same order. */
  optionIndexes?: number[];
  /** 'select' → selectOption, 'check' → click the matching input. */
  apply?: 'select' | 'check';
}

export interface FillPlan {
  actions: FillAction[];
  blockers: FillBlocker[];
  unmatched: FieldDescriptor[];
}

const IDENTITY_MATCHERS: { key: string; re: RegExp; exclude?: RegExp; value: (p: ApplyProfile) => string }[] = [
  { key: 'firstName', re: /first[\s_-]?name/i, value: (p) => p.firstName },
  { key: 'lastName', re: /last[\s_-]?name|surname|family[\s_-]?name/i, value: (p) => p.lastName },
  { key: 'email', re: /e-?mail/i, exclude: /confirm/i, value: (p) => p.email },
  { key: 'phone', re: /phone|mobile/i, value: (p) => p.phone },
  { key: 'linkedin', re: /linked[\s_-]?in/i, value: (p) => link(p, /linkedin/i) },
  { key: 'github', re: /git[\s_-]?hub/i, value: (p) => link(p, /github/i) },
  { key: 'website', re: /website|portfolio|personal\s+site/i, value: (p) => link(p, /portfolio|website|company/i) || firstLink(p) },
  { key: 'location', re: /\b(location|city|address)\b/i, exclude: /relocat/i, value: (p) => p.location },
  { key: 'fullName', re: /full[\s_-]?name|your[\s_-]?name|^name$/i, exclude: /company|employer|school/i, value: (p) => p.fullName },
];

function link(p: ApplyProfile, re: RegExp): string {
  return p.links.find((l) => re.test(l.label) || re.test(l.url))?.url ?? '';
}
function firstLink(p: ApplyProfile): string {
  return p.links[0]?.url ?? '';
}

function fieldKey(f: FieldDescriptor): string {
  return [f.labelText, f.ariaLabel, f.placeholder, f.name, f.id].join(' ').trim();
}

function questionOf(f: FieldDescriptor): string {
  return (f.labelText || f.ariaLabel || f.contextText || f.placeholder || f.name).trim().slice(0, 300);
}

function blockerReason(question: string): FillBlocker['reason'] {
  if (/salary|compensation|\bpay\b|desired\s+pay|rate\s+of\s+pay/i.test(question)) return 'salary';
  if (/start\s+date|when\s+can\s+you\s+start|earliest.*start|notice\s+period|availab/i.test(question)) return 'start_date';
  return 'unknown';
}

/** Option set for a field: the captured real options, or labels-only fallback. */
export function optionsOf(f: FieldDescriptor): FieldOption[] {
  if (f.optionSet && f.optionSet.length > 0) return f.optionSet;
  return f.options.map((label) => ({ value: label, label }));
}

/** Choose the <select> option matching an answer ("Yes, for any employer" → "Yes"). */
export function pickSelectOption(options: string[], answer: string): string | null {
  const match = matchOption(
    options.map((label) => ({ value: label, label })),
    answer,
  );
  return match?.option.label ?? null;
}

/**
 * Deterministic fill plan: identity fields, uploads, screening questions from
 * the defaults carried in profile.answers. Pure and unit-testable.
 */
export function planFormFill(fields: FieldDescriptor[], profile: ApplyProfile): FillPlan {
  const actions: FillAction[] = [];
  const blockers: FillBlocker[] = [];
  const unmatched: FieldDescriptor[] = [];
  const defaults = defaultsFromAnswers(profile.answers);
  const handled = new Set<number>();

  const visible = fields.filter((f) => f.visible);

  // 1) File uploads.
  for (const f of visible) {
    if (f.tag !== 'input' || f.type !== 'file') continue;
    handled.add(f.index);
    const key = fieldKey(f) + ' ' + f.contextText;
    if (/cover/i.test(key) && profile.coverLetterPath) {
      actions.push({ index: f.index, kind: 'upload-cover', value: profile.coverLetterPath, label: questionOf(f) });
    } else if (profile.resumePath) {
      actions.push({ index: f.index, kind: 'upload-resume', value: profile.resumePath, label: questionOf(f) });
    }
  }

  // 2) Radio groups (grouped by name; one "question" per group).
  const radioGroups = new Map<string, FieldDescriptor[]>();
  for (const f of visible) {
    if (f.tag === 'input' && f.type === 'radio') {
      const group = radioGroups.get(f.name) ?? [];
      group.push(f);
      radioGroups.set(f.name, group);
      handled.add(f.index);
    }
  }
  for (const group of radioGroups.values()) {
    const first = group[0]!;
    const question = (first.contextText || first.name).slice(0, 300);
    const match = matchScreeningAnswer(question, defaults);
    const required = group.some((g) => g.required);
    // The group's REAL options: one per radio input, label + submit value.
    const groupOptions: FieldOption[] = group.map((g) => ({
      value: g.value || g.labelText || g.id,
      label: (g.labelText || g.value || g.id).trim(),
    }));
    const optionIndexes = group.map((g) => g.index);
    if (!match) {
      if (required) {
        blockers.push({ question, reason: blockerReason(question), options: groupOptions, optionIndexes, index: first.index, apply: 'check' });
      } else {
        unmatched.push(first);
      }
      continue;
    }
    if (match.flagged) {
      if (required) {
        blockers.push({
          question,
          reason: blockerReason(question) === 'unknown' ? 'flagged' : blockerReason(question),
          options: groupOptions,
          optionIndexes,
          index: first.index,
          apply: 'check',
        });
      }
      continue;
    }
    const picked = matchOption(groupOptions, match.answer);
    const target = picked ? group.find((g) => (g.value || g.labelText || g.id) === picked.option.value) : undefined;
    if (target) {
      actions.push({ index: target.index, kind: 'check', value: picked!.option.label, label: question });
    } else if (required) {
      blockers.push({
        question,
        reason: 'no_option_match',
        options: groupOptions,
        optionIndexes,
        answer: match.answer,
        index: first.index,
        apply: 'check',
      });
    }
  }

  // 3) Everything else.
  for (const f of visible) {
    if (handled.has(f.index)) continue;

    if (f.tag === 'input' && f.type === 'checkbox') {
      const question = questionOf(f) + ' ' + f.contextText;
      if (/certify|acknowledge|agree|consent|accurate|confirm|terms/i.test(question)) {
        actions.push({ index: f.index, kind: 'check', value: 'checked', label: questionOf(f) });
      } else if (f.required) {
        blockers.push({ question: questionOf(f), reason: blockerReason(question) });
      } else {
        unmatched.push(f);
      }
      continue;
    }

    if (f.tag === 'input' && (f.type === 'hidden' || f.type === 'submit' || f.type === 'button')) continue;

    const key = fieldKey(f);

    // Identity fields (text-like inputs only).
    if (f.tag !== 'select') {
      const id = IDENTITY_MATCHERS.find((m) => m.re.test(key) && !(m.exclude && m.exclude.test(key)));
      if (id) {
        const value = id.value(profile);
        if (value) {
          actions.push({ index: f.index, kind: 'fill', value, label: questionOf(f) });
          continue;
        }
      }
      // Cover-letter textarea → paste the drafted letter text when available.
      if (f.tag === 'textarea' && /cover\s*letter/i.test(key + ' ' + f.contextText) && profile.coverLetterText) {
        actions.push({ index: f.index, kind: 'fill', value: profile.coverLetterText, label: questionOf(f) });
        continue;
      }
    }

    // Screening questions.
    const question = questionOf(f);
    const match = matchScreeningAnswer(question + ' ' + f.contextText.slice(0, 200), defaults);
    if (match) {
      const isChoice = f.tag === 'select';
      if (match.flagged) {
        if (f.required) {
          const reason = blockerReason(question + ' ' + f.contextText);
          blockers.push({
            question,
            reason: reason === 'unknown' ? 'flagged' : reason,
            ...(isChoice ? { options: optionsOf(f), index: f.index, apply: 'select' as const } : {}),
          });
        }
        continue;
      }
      if (isChoice) {
        const picked = matchOption(optionsOf(f), match.answer);
        if (picked) {
          actions.push({ index: f.index, kind: 'select', value: picked.option.label, label: question });
        } else if (f.required) {
          // A legal option exists, we just cannot prove which one — park with
          // the real options rather than guessing (agent pass runs first).
          blockers.push({
            question,
            reason: 'no_option_match',
            options: optionsOf(f),
            answer: match.answer,
            index: f.index,
            apply: 'select',
          });
        }
      } else {
        actions.push({ index: f.index, kind: 'fill', value: match.answer, label: question });
      }
      continue;
    }

    if (f.required && !f.value) {
      blockers.push({
        question,
        reason: blockerReason(question + ' ' + f.contextText),
        ...(f.tag === 'select' ? { options: optionsOf(f), index: f.index, apply: 'select' as const } : {}),
      });
    } else {
      unmatched.push(f);
    }
  }

  return { actions, blockers, unmatched };
}

/** Login wall: a visible password input and no application-form surface. */
export function isLoginWall(fields: FieldDescriptor[]): boolean {
  const visible = fields.filter((f) => f.visible);
  const hasPassword = visible.some((f) => f.type === 'password');
  const hasApplySurface = visible.some((f) => f.type === 'file' || f.tag === 'textarea');
  return hasPassword && !hasApplySurface;
}

/** Sign-up form: password + explicit account-creation language or confirm-password. */
export function isSignupForm(fields: FieldDescriptor[], pageText: string): boolean {
  const passwords = fields.filter((f) => f.visible && f.type === 'password');
  if (passwords.length === 0) return false;
  if (passwords.length >= 2) return true;
  return /create\s+(an\s+)?account|sign\s+up|register/i.test(pageText);
}

// ---------- agent-assisted mapping for generic forms ----------

const agentMapSchema = z.object({
  confidence: z.number().min(0).max(1),
  fills: z.array(z.object({ index: z.number().int(), value: z.string() })).default([]),
  selects: z.array(z.object({ index: z.number().int(), option: z.string() })).default([]),
  checks: z.array(z.object({ index: z.number().int() })).default([]),
  uploads: z.array(z.object({ index: z.number().int(), file: z.enum(['resume', 'coverLetter']) })).default([]),
  unanswerable: z.array(z.string()).default([]),
});

function buildMappingPrompt(fields: FieldDescriptor[], profile: ApplyProfile): string {
  const unanswered = Object.entries(profile.answers)
    .filter(([, v]) => typeof v !== 'string' || v === FLAGGED_FOR_USER)
    .map(([q]) => q);
  const safeProfile = {
    fullName: profile.fullName,
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    links: profile.links,
    screeningAnswers: usableProfileAnswers(profile),
    questionsOnlyTheCandidateCanAnswer: unanswered,
  };
  return [
    'You map job-application form fields to a candidate profile for automated,',
    'truthful form filling. Use ONLY the profile data below. Rules:',
    `- Any question the profile cannot answer (salary, start date, citizenship,`,
    `  unknown skills, or anything in "questionsOnlyTheCandidateCanAnswer") goes in "unanswerable" — never invent.`,
    '- confidence is YOUR overall confidence (0-1) that the mapping is correct and complete.',
    '- Only reference field "index" values that exist below.',
    '',
    '## Candidate profile + pre-approved screening answers',
    JSON.stringify(safeProfile, null, 2),
    '',
    fenceUntrusted('FORM_FIELDS', JSON.stringify(fields.map((f) => ({
      index: f.index, tag: f.tag, type: f.type, name: f.name, label: f.labelText || f.ariaLabel || f.placeholder,
      question: f.contextText.slice(0, 200), required: f.required, options: f.options.slice(0, 20),
    })), null, 2)),
    strictJsonFooter(
      '{ "confidence": number 0-1, "fills": [{"index": number, "value": string}],' +
        ' "selects": [{"index": number, "option": string}], "checks": [{"index": number}],' +
        ' "uploads": [{"index": number, "file": "resume"|"coverLetter"}], "unanswerable": string[] }',
    ),
  ].join('\n');
}

// ---------- the driver ----------

export interface PlaywrightDriverOptions {
  profileDir: string;
  /** Headed by default (the user can watch / take over); tests run headless. */
  headless?: boolean;
  navTimeoutMs?: number;
  /** Generic-form agent mapping below this confidence → needs_human. */
  confidenceThreshold?: number;
}

export class PlaywrightApplyDriver implements ApplyDriver {
  readonly name = 'playwright' as const;
  private contextPromise: Promise<BrowserContext> | null = null;

  constructor(private opts: PlaywrightDriverOptions) {}

  private async context(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = import('playwright').then(({ chromium }) => {
        fs.mkdirSync(this.opts.profileDir, { recursive: true });
        return chromium.launchPersistentContext(this.opts.profileDir, {
          headless: this.opts.headless ?? false,
          viewport: { width: 1280, height: 900 },
        });
      });
    }
    return this.contextPromise;
  }

  async apply(args: ApplyRunArgs): Promise<ApplyOutcome> {
    const context = await this.context();
    const page = await context.newPage();
    const shots: ApplyScreenshot[] = [];
    fs.mkdirSync(args.auditDir, { recursive: true });
    const snap = async (stage: ApplyScreenshot['stage']): Promise<void> => {
      const file = path.join(args.auditDir, `${Date.now()}-${stage}.png`);
      try {
        await page.screenshot({ path: file, fullPage: true });
        shots.push({ stage, path: file });
      } catch {
        /* screenshot failures never break the run */
      }
    };
    const blocked = async (prompt: string, choices: BlockedChoice[] = []): Promise<never> => {
      await snap('parked');
      // Browser stays open on purpose (FR-25): the user finishes manually.
      throw new ApplyBlocked(prompt, shots, choices);
    };

    const ats = detectAts(args.target.url);
    const timeout = this.opts.navTimeoutMs ?? 60000;
    await page.goto(args.target.url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(400);

    // Captcha check before anything is touched. Never auto-solved.
    let captcha = detectCaptcha(await page.content());
    if (captcha) {
      return blocked(
        `A ${captcha} is blocking ${args.target.company} — ${args.target.title}. ` +
          'Solve it manually in the open browser window, then resolve this task. Captchas are never solved automatically.',
      );
    }

    let fields = await collectFields(page);

    // Login / signup wall handling (FR-30).
    if (isLoginWall(fields)) {
      const site = hostOf(args.target.url);
      // Page-side code: DOM lib types are not loaded in the server tsconfig.
      const pageText = await page.evaluate(() => {
        const doc = (globalThis as { document?: { body?: { innerText?: string } } }).document;
        return doc?.body?.innerText?.slice(0, 4000) ?? '';
      });
      if (isSignupForm(fields, String(pageText))) {
        const password = generateStrongPassword();
        const filled = await this.fillLogin(page, fields, args.profile.email, password, true);
        if (!filled) {
          return blocked(`An account is required at ${site} and the sign-up form could not be filled automatically. Create the account manually (use ${args.profile.email}), then resolve this task.`);
        }
        await args.credentials.save(site, args.profile.email, password);
        captcha = detectCaptcha(await page.content());
        if (captcha) return blocked(`A ${captcha} appeared during account creation at ${site}. Solve it manually, then resolve this task. The generated password is stored in the vault.`);
      } else {
        const creds = await args.credentials.lookup(site);
        if (!creds) {
          return blocked(`${site} requires a login and no credential is stored in the vault. Log in manually in the open browser (or add the credential in Connections), then resolve this task.`);
        }
        const filled = await this.fillLogin(page, fields, creds.username, creds.password, true);
        if (!filled) {
          return blocked(`${site} requires a login; the stored credential could not be applied automatically. Log in manually in the open browser, then resolve this task.`);
        }
      }
      await page.waitForTimeout(1500);
      captcha = detectCaptcha(await page.content());
      if (captcha) return blocked(`A ${captcha} appeared after login. Solve it manually, then resolve this task.`);
      fields = await collectFields(page);
      if (isLoginWall(fields)) {
        return blocked(`Login at ${site} did not reach the application form. Finish logging in manually, then resolve this task.`);
      }
    }

    await snap('before-fill');

    // Build the fill plan.
    let plan = planFormFill(fields, args.profile);
    // Option-set escalation: a resolved answer that no deterministic rule could
    // map onto the field's REAL options gets one agent pass (cheap model) that
    // must choose from the enumerated options or return none.
    plan = await this.resolveOptionBlockers(args, plan);
    if (ats === 'generic' && plan.blockers.some((b) => b.reason === 'unknown')) {
      // Agent-assisted mapping for unknown generic forms (deterministic answers win).
      plan = await this.agentAssist(args, fields, plan);
    }
    if (plan.blockers.length > 0) {
      const lines = plan.blockers.map((b) => `- [${b.reason}] ${b.question}`);
      const choices: BlockedChoice[] = plan.blockers
        .filter((b) => (b.options?.length ?? 0) > 0)
        .map((b) => ({
          question: b.question,
          options: b.options!.filter((o) => o.label.trim() !== ''),
          ...(b.answer ? { answer: b.answer } : {}),
        }));
      return blocked(
        `The ${ats} application form for ${args.target.company} — ${args.target.title} has ${plan.blockers.length} question(s) that must not be answered automatically:\n` +
          `${lines.join('\n')}\n` +
          `The rest of the form data is pre-staged below; complete these fields in the open browser, submit, then resolve this task.\n` +
          `Pre-staged data: ${JSON.stringify({ ...identitySummary(args.profile), answers: usableProfileAnswers(args.profile) })}`,
        choices,
      );
    }

    // Execute the plan.
    const filledFields: Record<string, string> = {};
    const answersUsed: Record<string, string> = {};
    for (const action of plan.actions) {
      const sel = `[data-ajs-i="${action.index}"]`;
      try {
        if (action.kind === 'fill') {
          await page.fill(sel, action.value);
          filledFields[action.label] = action.value;
          answersUsed[action.label] = action.value;
        } else if (action.kind === 'select') {
          await page.selectOption(sel, { label: action.value });
          filledFields[action.label] = action.value;
          answersUsed[action.label] = action.value;
        } else if (action.kind === 'check') {
          await page.check(sel);
          filledFields[action.label] = action.value;
          answersUsed[action.label] = action.value;
        } else if (action.kind === 'upload-resume' || action.kind === 'upload-cover') {
          await page.setInputFiles(sel, action.value);
          filledFields[action.label] = path.basename(action.value);
        }
      } catch (err) {
        return blocked(
          `Could not fill "${action.label}" on the ${args.target.company} form (${err instanceof Error ? err.message.split('\n')[0] : err}). ` +
            'Finish the form manually in the open browser, then resolve this task.',
        );
      }
    }

    await snap('after-fill');

    if (!args.submit) {
      return { submitted: false, ats, confirmationText: null, screenshots: shots, filledFields, answersUsed };
    }

    // Submit — only reached with gate approval upstream.
    const submitButton = await findSubmitButton(page);
    if (!submitButton) {
      return blocked(`Form filled but no submit button was found on ${args.target.url}. Submit manually in the open browser, then resolve this task.`);
    }
    await submitButton.click();
    await page.waitForLoadState('load', { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(800);

    const afterHtml = await page.content();
    captcha = detectCaptcha(afterHtml);
    if (captcha) {
      return blocked(`A ${captcha} appeared at submission time. Solve it and submit manually in the open browser, then resolve this task.`);
    }
    const confirmationText = extractConfirmation(afterHtml);
    await snap('confirmation');
    return { submitted: true, ats, confirmationText, screenshots: shots, filledFields, answersUsed };
  }

  /**
   * One agent call per option blocker (cheap model — settings.modelScore tier).
   * The model may ONLY answer with an index into the real option list or null;
   * anything else keeps the blocker, so the human still decides.
   */
  private async resolveOptionBlockers(args: ApplyRunArgs, plan: FillPlan): Promise<FillPlan> {
    const pending = plan.blockers.filter((b) => b.reason === 'no_option_match' && b.answer && (b.options?.length ?? 0) > 0);
    if (pending.length === 0) return plan;

    const actions = [...plan.actions];
    const stillBlocked: FillBlocker[] = [];
    for (const blocker of plan.blockers) {
      if (!pending.includes(blocker)) {
        stillBlocked.push(blocker);
        continue;
      }
      const options = blocker.options!;
      let index: number | null = null;
      try {
        const result = await args.runner.run({
          prompt: buildOptionPrompt(blocker.question, blocker.answer!, options),
          model: args.optionModel ?? 'haiku',
          timeoutMs: Math.min(args.timeoutMs ?? 120000, 120000),
        });
        const parsed = z
          .object({ index: z.number().int().min(0).max(options.length - 1).nullable() })
          .safeParse(result.structured);
        index = parsed.success ? parsed.data.index : null;
      } catch {
        index = null; // an agent failure is a park, never a guess
      }
      const chosen = index == null ? null : options[index];
      if (!chosen) {
        stillBlocked.push(blocker);
        continue;
      }
      if (blocker.apply === 'check') {
        // Radio/checkbox group: each option carries its own input index.
        const idx = blocker.optionIndexes?.[index!];
        if (idx == null) {
          stillBlocked.push(blocker);
          continue;
        }
        actions.push({ index: idx, kind: 'check', value: chosen.label, label: blocker.question });
      } else {
        actions.push({ index: blocker.index!, kind: 'select', value: chosen.label, label: blocker.question });
      }
    }
    return { ...plan, actions, blockers: stillBlocked };
  }

  private async agentAssist(args: ApplyRunArgs, fields: FieldDescriptor[], deterministic: FillPlan): Promise<FillPlan> {
    const threshold = this.opts.confidenceThreshold ?? 0.75;
    let mapped: z.infer<typeof agentMapSchema>;
    try {
      const result = await args.runner.run({
        prompt: buildMappingPrompt(fields, args.profile),
        timeoutMs: args.timeoutMs ?? 180000,
      });
      const parsed = agentMapSchema.safeParse(result.structured);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'no JSON');
      mapped = parsed.data;
    } catch (err) {
      return {
        ...deterministic,
        blockers: [
          ...deterministic.blockers,
          { question: `agent mapping failed (${err instanceof Error ? err.message : err})`, reason: 'unknown' },
        ],
      };
    }
    if (mapped.confidence < threshold || mapped.unanswerable.length > 0) {
      const extra: FillBlocker[] = [
        ...mapped.unanswerable.map((q) => ({ question: q, reason: blockerReason(q) === 'unknown' ? ('flagged' as const) : blockerReason(q) })),
        ...(mapped.confidence < threshold
          ? [{ question: `agent mapping confidence ${mapped.confidence.toFixed(2)} below ${threshold}`, reason: 'unknown' as const }]
          : []),
      ];
      return { ...deterministic, blockers: [...deterministic.blockers.filter((b) => b.reason !== 'unknown'), ...extra] };
    }
    // Merge: deterministic actions win; agent covers previously-unknown fields.
    const covered = new Set(deterministic.actions.map((a) => a.index));
    const byIndex = new Map(fields.map((f) => [f.index, f]));
    const actions = [...deterministic.actions];
    const push = (index: number, kind: FillAction['kind'], value: string) => {
      const f = byIndex.get(index);
      if (!f || covered.has(index)) return;
      covered.add(index);
      actions.push({ index, kind, value, label: questionOf(f) });
    };
    for (const m of mapped.fills) push(m.index, 'fill', m.value);
    for (const m of mapped.selects) push(m.index, 'select', m.option);
    for (const m of mapped.checks) push(m.index, 'check', 'checked');
    for (const m of mapped.uploads) {
      const file = m.file === 'resume' ? args.profile.resumePath : args.profile.coverLetterPath;
      if (file) push(m.index, m.file === 'resume' ? 'upload-resume' : 'upload-cover', file);
    }
    return { actions, blockers: deterministic.blockers.filter((b) => b.reason !== 'unknown'), unmatched: [] };
  }

  private async fillLogin(page: Page, fields: FieldDescriptor[], username: string, password: string, submit: boolean): Promise<boolean> {
    const visible = fields.filter((f) => f.visible);
    const user = visible.find((f) => f.type === 'email' || /e-?mail|user/i.test(fieldKey(f)));
    const passwords = visible.filter((f) => f.type === 'password');
    if (!user || passwords.length === 0) return false;
    try {
      await page.fill(`[data-ajs-i="${user.index}"]`, username);
      for (const p of passwords) await page.fill(`[data-ajs-i="${p.index}"]`, password);
      if (submit) {
        const button = await findSubmitButton(page);
        if (button) await button.click();
      }
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.contextPromise) {
      const context = await this.contextPromise.catch(() => null);
      this.contextPromise = null;
      await context?.close().catch(() => undefined);
    }
  }
}

// ---------- page helpers ----------

/** Tag every form control with data-ajs-i and return serializable descriptors. */
async function collectFields(page: Page): Promise<FieldDescriptor[]> {
  // Runs INSIDE the browser: DOM lib types are not loaded in the server
  // tsconfig, so the page-side code is deliberately untyped.
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const g = globalThis as any;
    const doc = g.document;
    const out: FieldDescriptor[] = [];
    const controls: any[] = Array.from(doc.querySelectorAll('input, textarea, select'));
    controls.forEach((el: any, i: number) => {
      el.setAttribute('data-ajs-i', String(i));
      const style = g.window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const type = String(el.type || '').toLowerCase();
      const visible =
        style.display !== 'none' && style.visibility !== 'hidden' && (rect.width > 0 || rect.height > 0 || type === 'file');
      let labelText = '';
      const id = el.getAttribute('id') ?? '';
      if (id) {
        const label = doc.querySelector(`label[for="${g.CSS.escape(id)}"]`);
        if (label) labelText = String(label.textContent ?? '').trim();
      }
      if (!labelText) {
        const wrapping = el.closest('label');
        if (wrapping) labelText = String(wrapping.textContent ?? '').trim();
      }
      const container = el.closest('fieldset, .field, .form-group, .application-question, li, div');
      const contextText = String(container?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 400);
      // Real option set: visible label AND submit value, so a resolved answer
      // can be mapped onto a LEGAL option instead of typed blindly.
      const optionSet =
        String(el.tagName).toLowerCase() === 'select'
          ? Array.from(el.options as any[]).map((o: any) => ({
              value: String(o.value ?? o.textContent ?? '').trim(),
              label: String(o.textContent ?? o.value ?? '').trim().replace(/\s+/g, ' '),
            }))
          : [];
      const options = optionSet.map((o: { label: string }) => o.label);
      out.push({
        index: i,
        tag: String(el.tagName).toLowerCase() as FieldDescriptor['tag'],
        type,
        name: el.getAttribute('name') ?? '',
        id,
        placeholder: el.getAttribute('placeholder') ?? '',
        ariaLabel: el.getAttribute('aria-label') ?? '',
        labelText: labelText.replace(/\s+/g, ' ').slice(0, 300),
        contextText,
        required: el.required === true || el.getAttribute('aria-required') === 'true',
        visible,
        value: 'value' in el ? String(el.value ?? '') : '',
        options,
        optionSet,
      });
    });
    return out;
  });
}

async function findSubmitButton(page: Page): Promise<import('playwright').Locator | null> {
  const selectors = ['button[type="submit"]', 'input[type="submit"]', '#submit_app', 'button#btn-submit'];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
  }
  const byText = page.getByRole('button', { name: /submit|apply|send application/i }).first();
  if ((await byText.count()) > 0) return byText;
  return null;
}

function extractConfirmation(html: string): string | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const m =
    /([^.]*\b(thank you|application (?:has been |was )?(?:submitted|received)|we(?:'| ha)ve received your application)[^.]*\.?)/i.exec(
      text,
    );
  return m?.[1]?.trim() ?? null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function identitySummary(p: ApplyProfile): Record<string, string> {
  return { name: p.fullName, email: p.email, phone: p.phone, location: p.location };
}

/** Pre-staged data never carries a needs-user marker — only real answers. */
function usableProfileAnswers(p: ApplyProfile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [q, v] of Object.entries(p.answers)) {
    if (typeof v === 'string' && v !== FLAGGED_FOR_USER) out[q] = v;
  }
  return out;
}

export { detectAts, detectCaptcha };
export type { AtsKind };
