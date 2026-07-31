// Submit-gate decision logic (PRD D1, FR-9).
//   review → wait for the user … UNLESS autoSubmitWhenResolved is on AND every
//            screening answer resolved (nothing left for a human to decide).
//   auto   → submit once checks pass (still blocked by legitimacy).
//   hybrid → auto when fitScore ≥ threshold, review otherwise.
// Per-source overrides (settings.perSourceGates) win over the global mode;
// suspicious/scam legitimacy always forces review/quarantine regardless of gate.
//
// Two hard exceptions to auto-submission, in every mode:
//   1. ALWAYS_REVIEW_SOURCES (LinkedIn) — human-paced by policy (PRD §8).
//   2. answersResolved === false in review/hybrid — an unanswered screening
//      question is exactly where guessing would be lying, so it waits. Explicit
//      'auto' is unchanged: the driver still parks on the question itself.
// answersResolved === undefined means "not evaluated" and keeps the legacy
// behavior, so callers that predate standing answers are unaffected.
import type { GateMode, LegitVerdict, Settings } from '@shared/types';

/** Sources that are never auto-submitted, whatever the gate says. */
export const ALWAYS_REVIEW_SOURCES = ['linkedin'];

export interface GateInput {
  source: string;
  fitScore: number | null;
  legitVerdict: LegitVerdict;
  /** false → at least one screening answer still needs the user. */
  answersResolved?: boolean;
}

export interface GateDecision {
  mode: GateMode;
  /** true → submit without waiting for the user (logged as auto-approval). */
  autoSubmit: boolean;
  reason: string;
  /** true when the submission happened only because everything resolved. */
  viaResolved?: boolean;
}

export function decideGate(settings: Settings, input: GateInput): GateDecision {
  const mode: GateMode = settings.perSourceGates[input.source] ?? settings.gateMode;

  if (input.legitVerdict === 'scam') {
    return { mode, autoSubmit: false, reason: 'Legitimacy verdict is scam — quarantined, never submitted' };
  }
  if (input.legitVerdict === 'suspicious') {
    return { mode, autoSubmit: false, reason: 'Legitimacy verdict is suspicious — review required' };
  }
  const alwaysReview = ALWAYS_REVIEW_SOURCES.includes(input.source);
  const unresolved = input.answersResolved === false;

  switch (mode) {
    case 'review': {
      if (unresolved) {
        return {
          mode,
          autoSubmit: false,
          reason: 'Screening answers still need you — nothing is guessed, so this waits for review',
        };
      }
      if (input.answersResolved === true && settings.autoSubmitWhenResolved && !alwaysReview) {
        return {
          mode,
          autoSubmit: true,
          viaResolved: true,
          reason: 'Every screening answer resolved from your profile and standing answers — submitted automatically',
        };
      }
      return {
        mode,
        autoSubmit: false,
        reason: alwaysReview
          ? `Gate mode review — ${input.source} is always human-paced`
          : 'Gate mode review — user approval required',
      };
    }
    case 'auto':
      if (alwaysReview) {
        return { mode, autoSubmit: false, reason: `${input.source} is always human-paced — auto gate overridden` };
      }
      return { mode, autoSubmit: true, reason: 'Gate mode auto — submitting after checks (audit logged)' };
    case 'hybrid': {
      const score = input.fitScore ?? 0;
      if (alwaysReview) {
        return { mode, autoSubmit: false, reason: `${input.source} is always human-paced — hybrid gate overridden` };
      }
      if (unresolved) {
        return {
          mode,
          autoSubmit: false,
          reason: 'Screening answers still need you — nothing is guessed, so this waits for review',
        };
      }
      if (score >= settings.hybridThreshold) {
        return {
          mode,
          autoSubmit: true,
          viaResolved: input.answersResolved === true,
          reason: `Hybrid gate: fit ${score} ≥ threshold ${settings.hybridThreshold} — auto-submit`,
        };
      }
      return {
        mode,
        autoSubmit: false,
        reason: `Hybrid gate: fit ${score} < threshold ${settings.hybridThreshold} — review required`,
      };
    }
  }
}
