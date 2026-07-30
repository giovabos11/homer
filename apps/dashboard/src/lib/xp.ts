import type { Application, EmailRecord, PrepTask } from '@shared';

/**
 * Gamification math — XP is computed from real pipeline actions, never stored.
 * Values chosen so a healthy week of activity levels you up about once.
 */
export interface XpBreakdown {
  applicationsSent: number;
  interviewsEarned: number;
  offers: number;
  prepDone: number;
  approvals: number;
  xp: number;
  level: number;
  levelFloor: number;
  levelCeil: number;
  progress: number; // 0..1 within current level
  title: string;
}

const XP_PER = { application: 25, interview: 100, offer: 250, prep: 10, approval: 15 } as const;

const TITLES = [
  'Job Seeker',
  'Applicant',
  'Prospect',
  'Contender',
  'Interview Ace',
  'Negotiator',
  'Closer',
  'Offer Magnet',
  'Career Legend',
];

export function xpForLevel(level: number): number {
  // cumulative XP required to *reach* `level` (level 1 = 0 XP)
  let total = 0;
  for (let l = 1; l < level; l++) total += Math.round(80 + l * 45);
  return total;
}

export function computeXp(
  applications: Application[],
  prepTasks: PrepTask[],
  emails: EmailRecord[],
): XpBreakdown {
  const applicationsSent = applications.filter((a) => a.submittedAt != null).length;
  const interviewsEarned = applications.filter((a) =>
    ['interview', 'offer', 'hired'].includes(a.status),
  ).length;
  const offers = applications.filter((a) => ['offer', 'hired'].includes(a.status)).length;
  const prepDone = prepTasks.filter((t) => t.doneAt != null).length;
  const approvals = emails.filter((e) => e.approvedAt != null).length;

  const xp =
    applicationsSent * XP_PER.application +
    interviewsEarned * XP_PER.interview +
    offers * XP_PER.offer +
    prepDone * XP_PER.prep +
    approvals * XP_PER.approval;

  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  const levelFloor = xpForLevel(level);
  const levelCeil = xpForLevel(level + 1);
  const progress = Math.min(1, (xp - levelFloor) / Math.max(1, levelCeil - levelFloor));
  const title = TITLES[Math.min(TITLES.length - 1, level - 1)] ?? 'Career Legend';

  return { applicationsSent, interviewsEarned, offers, prepDone, approvals, xp, level, levelFloor, levelCeil, progress, title };
}

/** Consecutive-day streak ending today (or yesterday, grace) from activity timestamps. */
export function computeStreak(dates: (string | null | undefined)[]): number {
  const days = new Set(
    dates
      .filter((d): d is string => !!d)
      .map((d) => new Date(d).toISOString().slice(0, 10)),
  );
  if (days.size === 0) return 0;
  const dayMs = 86400000;
  let cursor = new Date(new Date().toISOString().slice(0, 10)).getTime();
  // grace: streak counts if latest activity was yesterday
  if (!days.has(new Date(cursor).toISOString().slice(0, 10))) cursor -= dayMs;
  let streak = 0;
  while (days.has(new Date(cursor).toISOString().slice(0, 10))) {
    streak++;
    cursor -= dayMs;
  }
  return streak;
}
