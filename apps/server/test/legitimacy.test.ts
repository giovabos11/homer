// Legitimacy structural signals: employer-task check-cashing phrasing only,
// benign HR language ignored, and structural signals capped at 'suspicious'
// (scam requires the agent verification to concur via the worst-verdict merge).
import { describe, expect, it } from 'vitest';
import { keywordSignals, mergeVerdicts, verdictFromSignals } from '../src/pipeline/legitimacy';

const DUOLINGO_DISCLAIMER =
  'Duolingo and our employees will never ask for your Social Security number, ' +
  "bank details, or passport info, and we'll never ask you to deposit a check, " +
  'purchase equipment, or exchange money during the interview process.';

describe('keyword signals — check-cashing pattern', () => {
  it('does NOT match an anti-fraud disclaimer ("we\'ll never ask you to deposit a check")', () => {
    expect(keywordSignals(DUOLINGO_DISCLAIMER)).toEqual([]);
  });

  it('does NOT match benign HR phrases (background/reference checks, direct deposit)', () => {
    const text =
      'We conduct background checks on all hires, may request reference checks, ' +
      'and pay via direct deposit. A credit check may apply for finance roles.';
    expect(keywordSignals(text)).toEqual([]);
  });

  it('matches employer-task phrasing: cashing checks for the employer', () => {
    const signals = keywordSignals('Your daily duties include cashing checks for our clients.');
    expect(signals.map((s) => s.code)).toContain('check_cashing');
  });

  it('matches "deposit checks on behalf of" phrasing', () => {
    const signals = keywordSignals('You will deposit checks on behalf of the company each week.');
    expect(signals.map((s) => s.code)).toContain('check_cashing');
  });

  it('still flags pay-to-apply and wire-transfer language', () => {
    expect(keywordSignals('A small application fee is required.').map((s) => s.code)).toContain('pay_to_apply');
    expect(keywordSignals('Funds move via wire transfer weekly.').map((s) => s.code)).toContain('wire_transfer');
  });
});

describe('verdict capping', () => {
  it('structural signals alone cap at suspicious — even classic-scam (hard) ones', () => {
    const signals = keywordSignals('Duties: cashing checks for our clients daily.');
    expect(signals.length).toBeGreaterThan(0);
    expect(verdictFromSignals(signals)).toBe('suspicious');
  });

  it('no signals → legit', () => {
    expect(verdictFromSignals([])).toBe('legit');
  });

  it('agent concurrence upgrades to scam via the worst-verdict merge', () => {
    expect(mergeVerdicts('suspicious', 'scam')).toBe('scam');
    expect(mergeVerdicts('suspicious', 'legit')).toBe('suspicious');
    expect(mergeVerdicts('legit', 'legit')).toBe('legit');
  });
});
