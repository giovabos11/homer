// Apply-driver tests (FR-9/FR-25/FR-30, PRD D5).
// SAFETY: every browser run here targets LOCAL fixture forms (test/fixtures/*
// via file://) — never a real employer. Captchas are detected, never solved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ApplyBlocked, detectAts, detectCaptcha, generateStrongPassword, type ApplyProfile } from '../src/apply/driver';
import { isLoginWall, planFormFill, pickSelectOption, PlaywrightApplyDriver, type FieldDescriptor } from '../src/apply/playwright-driver';
import { MockRunner } from '../src/agent/mock-runner';
import { FLAGGED_FOR_USER } from '../src/docs/screening';

const fixtures = path.join(__dirname, 'fixtures');
const fixtureUrl = (name: string) => pathToFileURL(path.join(fixtures, name)).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ajs-driver-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const profile: ApplyProfile = {
  fullName: 'Test Candidate',
  firstName: 'Test',
  lastName: 'Candidate',
  email: 'test.candidate@example.com',
  phone: '+1 555-010-0000',
  location: 'Dallas, TX 75231',
  links: [{ label: 'GitHub', url: 'https://github.com/testcandidate' }],
  resumePath: null,
  coverLetterPath: null,
  answers: {
    'Are you authorized to work in the US?': 'Yes, for any employer',
    'Will you now or in the future require sponsorship?': 'No',
    'Are you willing to relocate?': 'Yes, anywhere in the US',
    'Salary expectations': FLAGGED_FOR_USER,
    'Earliest start date': FLAGGED_FOR_USER,
  },
};

const noCreds = { lookup: async () => null, save: async () => undefined };

describe('captcha + ATS detection (pure)', () => {
  it('detects reCAPTCHA / hCaptcha / Turnstile in the fixture HTML files', () => {
    expect(detectCaptcha(fs.readFileSync(path.join(fixtures, 'captcha-recaptcha.html'), 'utf8'))).toBe('Google reCAPTCHA');
    expect(detectCaptcha(fs.readFileSync(path.join(fixtures, 'captcha-hcaptcha.html'), 'utf8'))).toBe('hCaptcha');
    expect(detectCaptcha(fs.readFileSync(path.join(fixtures, 'captcha-turnstile.html'), 'utf8'))).toBe('Cloudflare Turnstile');
    expect(detectCaptcha('<p>Please verify you are a human to continue</p>')).toBe('human-verification challenge');
    expect(detectCaptcha(fs.readFileSync(path.join(fixtures, 'greenhouse.html'), 'utf8'))).toBeNull();
  });

  it('classifies ATS platforms from apply URLs', () => {
    expect(detectAts('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(detectAts('https://job-boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse');
    expect(detectAts('https://jobs.lever.co/acme/xyz/apply')).toBe('lever');
    expect(detectAts('https://jobs.ashbyhq.com/acme/xyz')).toBe('ashby');
    expect(detectAts('https://careers.acme.com/apply')).toBe('generic');
  });

  it('generates strong unique vault passwords', () => {
    const a = generateStrongPassword();
    const b = generateStrongPassword();
    expect(a).toHaveLength(20);
    expect(a).not.toBe(b);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[!@#$%^&*\-_+=]/);
  });
});

function field(partial: Partial<FieldDescriptor> & { index: number }): FieldDescriptor {
  return {
    tag: 'input', type: 'text', name: '', id: '', placeholder: '', ariaLabel: '',
    labelText: '', contextText: '', required: false, visible: true, value: '', options: [],
    ...partial,
  };
}

describe('planFormFill (pure)', () => {
  it('fills identity, answers screening from defaults, and blocks salary/unknown required questions', () => {
    const fields = [
      field({ index: 0, id: 'first_name', labelText: 'First Name *', required: true }),
      field({ index: 1, id: 'email', type: 'email', labelText: 'Email *', required: true }),
      field({ index: 2, tag: 'select', labelText: 'Are you authorized to work in the US?', required: true, options: ['Please select', 'Yes', 'No'] }),
      field({ index: 3, labelText: 'What are your salary expectations?', required: true }),
      field({ index: 4, labelText: 'Describe your favorite database migration', required: true }),
      field({ index: 5, labelText: 'Optional nickname' }),
    ];
    const plan = planFormFill(fields, profile);
    const byIndex = new Map(plan.actions.map((a) => [a.index, a]));
    expect(byIndex.get(0)?.value).toBe('Test');
    expect(byIndex.get(1)?.value).toBe('test.candidate@example.com');
    expect(byIndex.get(2)?.kind).toBe('select');
    expect(byIndex.get(2)?.value).toBe('Yes');
    expect(plan.blockers.map((b) => b.reason).sort()).toEqual(['salary', 'unknown']);
    expect(plan.unmatched.some((f) => f.index === 5)).toBe(true); // optional unknowns are left blank, not blockers
  });

  it('radio groups answer yes/no from screening defaults', () => {
    const fields = [
      field({ index: 0, type: 'radio', name: 'relocate', labelText: 'Yes', contextText: 'Are you willing to relocate? Yes No', required: true }),
      field({ index: 1, type: 'radio', name: 'relocate', labelText: 'No', contextText: 'Are you willing to relocate? Yes No' }),
    ];
    const plan = planFormFill(fields, profile);
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toEqual([expect.objectContaining({ index: 0, kind: 'check' })]);
  });

  it('pickSelectOption reduces verbose defaults to the yes/no option', () => {
    expect(pickSelectOption(['Please select', 'Yes', 'No'], 'Yes, for any employer')).toBe('Yes');
    expect(pickSelectOption(['--', 'Yes', 'No'], 'No')).toBe('No');
    expect(pickSelectOption(['Red', 'Blue'], 'Yes')).toBeNull();
  });

  it('isLoginWall: password without an application surface', () => {
    expect(isLoginWall([field({ index: 0, type: 'password' }), field({ index: 1, type: 'email' })])).toBe(true);
    expect(isLoginWall([field({ index: 0, type: 'password' }), field({ index: 1, type: 'file' })])).toBe(false);
    expect(isLoginWall([field({ index: 0, type: 'email' })])).toBe(false);
  });
});

describe('PlaywrightApplyDriver against local fixture forms', () => {
  it('fills, uploads, submits the greenhouse-style fixture, and captures the audit screenshots', async () => {
    const resumePdf = path.join(tmp, 'resume.pdf');
    fs.writeFileSync(resumePdf, '%PDF-1.4 fixture');
    const driver = new PlaywrightApplyDriver({ profileDir: path.join(tmp, 'profile-a'), headless: true });
    try {
      const outcome = await driver.apply({
        target: { url: fixtureUrl('greenhouse.html'), company: 'Fixture Co', title: 'Software Engineer' },
        profile: { ...profile, resumePath: resumePdf },
        auditDir: path.join(tmp, 'audit-a'),
        submit: true,
        credentials: noCreds,
        runner: new MockRunner(),
      });
      expect(outcome.submitted).toBe(true);
      expect(outcome.confirmationText).toContain('Thank you for applying');
      const stages = outcome.screenshots.map((s) => s.stage);
      expect(stages).toContain('before-fill');
      expect(stages).toContain('after-fill');
      expect(stages).toContain('confirmation');
      for (const s of outcome.screenshots) expect(fs.existsSync(s.path)).toBe(true);
      expect(Object.values(outcome.filledFields)).toContain('Test');
      expect(Object.values(outcome.answersUsed)).toContain('No'); // sponsorship select
    } finally {
      await driver.dispose();
    }
  }, 90000);

  it('parks (never submits) when a required salary question is present', async () => {
    const driver = new PlaywrightApplyDriver({ profileDir: path.join(tmp, 'profile-b'), headless: true });
    try {
      await expect(
        driver.apply({
          target: { url: fixtureUrl('salary-required.html'), company: 'Fixture Co', title: 'Backend Engineer' },
          profile,
          auditDir: path.join(tmp, 'audit-b'),
          submit: true,
          credentials: noCreds,
          runner: new MockRunner(),
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof ApplyBlocked && /\[salary\]/.test((err as ApplyBlocked).prompt));
    } finally {
      await driver.dispose();
    }
  }, 90000);

  it('parks on a captcha wall before touching the form (never auto-solved)', async () => {
    const driver = new PlaywrightApplyDriver({ profileDir: path.join(tmp, 'profile-c'), headless: true });
    try {
      await expect(
        driver.apply({
          target: { url: fixtureUrl('captcha-recaptcha.html'), company: 'Fixture Co', title: 'Software Engineer' },
          profile,
          auditDir: path.join(tmp, 'audit-c'),
          submit: true,
          credentials: noCreds,
          runner: new MockRunner(),
        }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof ApplyBlocked && /reCAPTCHA/.test((err as ApplyBlocked).prompt) && /never solved automatically/i.test((err as ApplyBlocked).prompt),
      );
    } finally {
      await driver.dispose();
    }
  }, 90000);
});
