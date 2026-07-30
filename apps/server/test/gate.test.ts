import { describe, expect, it } from 'vitest';
import type { Settings } from '@shared/types';
import { decideGate } from '../src/pipeline/gate';

const baseSettings: Settings = {
  gateMode: 'review',
  hybridThreshold: 75,
  discoveryIntervalMinutes: 360,
  emailScanIntervalMinutes: 120,
  country: 'US',
  applyDriver: 'playwright',
  perSourceGates: { linkedin: 'review' },
  followupAfterDays: 10,
  maxFollowups: 2,
};

describe('submit-gate decision (D1)', () => {
  it('review mode never auto-submits', () => {
    const d = decideGate(baseSettings, { source: 'freehire', fitScore: 99, legitVerdict: 'legit' });
    expect(d.mode).toBe('review');
    expect(d.autoSubmit).toBe(false);
  });

  it('auto mode submits after checks pass', () => {
    const d = decideGate({ ...baseSettings, gateMode: 'auto' }, { source: 'freehire', fitScore: 10, legitVerdict: 'legit' });
    expect(d.autoSubmit).toBe(true);
  });

  it('hybrid honors the threshold boundary (>= submits)', () => {
    const settings = { ...baseSettings, gateMode: 'hybrid' as const };
    expect(decideGate(settings, { source: 'freehire', fitScore: 75, legitVerdict: 'legit' }).autoSubmit).toBe(true);
    expect(decideGate(settings, { source: 'freehire', fitScore: 74, legitVerdict: 'legit' }).autoSubmit).toBe(false);
    expect(decideGate(settings, { source: 'freehire', fitScore: null, legitVerdict: 'legit' }).autoSubmit).toBe(false);
  });

  it('per-source override wins over the global mode (LinkedIn always review)', () => {
    const settings = { ...baseSettings, gateMode: 'auto' as const };
    const d = decideGate(settings, { source: 'linkedin', fitScore: 95, legitVerdict: 'legit' });
    expect(d.mode).toBe('review');
    expect(d.autoSubmit).toBe(false);
    // Non-overridden source still follows global auto.
    expect(decideGate(settings, { source: 'freehire', fitScore: 95, legitVerdict: 'legit' }).autoSubmit).toBe(true);
  });

  it('suspicious legitimacy always forces review; scam never submits', () => {
    const auto = { ...baseSettings, gateMode: 'auto' as const };
    expect(decideGate(auto, { source: 'freehire', fitScore: 99, legitVerdict: 'suspicious' }).autoSubmit).toBe(false);
    expect(decideGate(auto, { source: 'freehire', fitScore: 99, legitVerdict: 'scam' }).autoSubmit).toBe(false);
    const hybrid = { ...baseSettings, gateMode: 'hybrid' as const };
    expect(decideGate(hybrid, { source: 'freehire', fitScore: 99, legitVerdict: 'suspicious' }).autoSubmit).toBe(false);
  });
});
