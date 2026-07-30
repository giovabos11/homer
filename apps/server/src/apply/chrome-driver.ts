// ChromeApplyDriver (PRD D5) — the driver for automation-hostile sites
// (LinkedIn et al.) that must go through the user's REAL Chrome session via the
// Claude in Chrome extension. The server cannot (and must not) drive that
// session headlessly, so this driver always parks the task as needs_human with
// step-by-step instructions and the pre-staged data. The interactive
// claude-in-chrome flow (a Claude session with the extension connected) then
// walks the user through the form at human pace, and the user resolves the
// task from the dashboard when done. LinkedIn applies are always review-gated
// and human-paced (PRD §8 — the AIHawk precedent).
import { ApplyBlocked, type ApplyDriver, type ApplyOutcome, type ApplyRunArgs } from './driver';

export class ChromeApplyDriver implements ApplyDriver {
  readonly name = 'chrome' as const;

  async apply(args: ApplyRunArgs): Promise<ApplyOutcome> {
    const p = args.profile;
    const staged = {
      name: p.fullName,
      email: p.email,
      phone: p.phone,
      location: p.location,
      links: p.links,
      resumePdf: p.resumePath,
      coverLetterPdf: p.coverLetterPath,
      screeningAnswers: p.answers,
    };
    throw new ApplyBlocked(
      [
        `Claude-in-Chrome apply for ${args.target.company} — ${args.target.title}:`,
        `1. Open a Claude session with the Claude in Chrome extension connected.`,
        `2. Navigate to ${args.target.url} in your own Chrome (stay logged in as yourself).`,
        `3. Fill the form at human pace using the pre-staged data below; upload the tailored PDFs.`,
        `4. Answer nothing marked FLAGGED_FOR_USER without deciding it yourself (salary, start date, citizenship).`,
        `5. Submit only if you (the human) are satisfied, then resolve this task on the dashboard.`,
        `Pre-staged data: ${JSON.stringify(staged)}`,
      ].join('\n'),
    );
  }

  async dispose(): Promise<void> {
    /* nothing to dispose — the user's own Chrome is never owned by the server */
  }
}
