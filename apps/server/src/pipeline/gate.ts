// Submit-gate decision logic (PRD D1, FR-9).
//   review → always wait for the user.
//   auto   → submit once checks pass (still blocked by legitimacy).
//   hybrid → auto when fitScore ≥ threshold, review otherwise.
// Per-source overrides (settings.perSourceGates) win over the global mode;
// suspicious/scam legitimacy always forces review/quarantine regardless of gate.
import type { GateMode, LegitVerdict, Settings } from '@shared/types';

export interface GateInput {
  source: string;
  fitScore: number | null;
  legitVerdict: LegitVerdict;
}

export interface GateDecision {
  mode: GateMode;
  /** true → submit without waiting for the user (logged as auto-approval). */
  autoSubmit: boolean;
  reason: string;
}

export function decideGate(settings: Settings, input: GateInput): GateDecision {
  const mode: GateMode = settings.perSourceGates[input.source] ?? settings.gateMode;

  if (input.legitVerdict === 'scam') {
    return { mode, autoSubmit: false, reason: 'Legitimacy verdict is scam — quarantined, never submitted' };
  }
  if (input.legitVerdict === 'suspicious') {
    return { mode, autoSubmit: false, reason: 'Legitimacy verdict is suspicious — review required' };
  }

  switch (mode) {
    case 'review':
      return { mode, autoSubmit: false, reason: 'Gate mode review — user approval required' };
    case 'auto':
      return { mode, autoSubmit: true, reason: 'Gate mode auto — submitting after checks (audit logged)' };
    case 'hybrid': {
      const score = input.fitScore ?? 0;
      if (score >= settings.hybridThreshold) {
        return {
          mode,
          autoSubmit: true,
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
