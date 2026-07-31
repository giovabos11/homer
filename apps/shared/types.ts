// Shared API types — single source of truth for apps/server and apps/dashboard.
// Server imports via tsconfig path alias "@shared/*"; dashboard via vite alias "@shared".

export type GateMode = 'review' | 'auto' | 'hybrid';
export type JobStatus =
  | 'discovered' | 'screened' | 'tailoring' | 'ready_for_review'
  | 'applied' | 'interview' | 'offer' | 'hired' | 'rejected'
  | 'no_response' | 'withdrawn' | 'quarantined' | 'skipped';
export type RemoteType = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type LegitVerdict = 'legit' | 'suspicious' | 'scam' | 'unchecked';
export type TaskState = 'pending' | 'running' | 'paused' | 'needs_human' | 'waiting_session' | 'done' | 'failed';
export type TaskType =
  | 'discover' | 'score' | 'tailor' | 'apply' | 'email_scan'
  | 'email_send' | 'followup' | 'prep_guide' | 'profile_sync' | 'ask' | 'feedback'
  | 'setup' | 'regen_queries';
/** Claude model alias for a task family. 'default' = whatever the user's Claude Code defaults to. */
export type ModelChoice = 'default' | 'haiku' | 'sonnet' | 'opus';
export type EmailDirection = 'inbound' | 'outbound';
/**
 * `offer` is distinct from `reply_accepted` on purpose: a formal offer (comp,
 * start date, a deadline to respond) moves the application to Offer, while a
 * positive interim reply only moves it to Interview. Without the distinction an
 * offer email read as "moving forward" and the Offer column could never fill.
 * `hired` and `offer_declined` stay user actions and are never auto-proposed.
 */
export type EmailClass =
  | 'reply_accepted' | 'reply_rejected' | 'interview_invite' | 'offer'
  | 'opportunity' | 'followup' | 'other';

/** Strongest signal that linked an inbound email to an application. */
export type EmailMatchBasis = 'url' | 'company_title' | 'company' | 'manual';

/** One application an ambiguous email might be about, offered as a choice. */
export interface EmailMatchCandidate {
  applicationId: number;
  jobId: number;
  company: string;
  title: string;
  status: JobStatus;
}
export type ConnectionName =
  | 'server' | 'claude_code' | 'gmail' | 'playwright' | 'chrome'
  | 'ats_boards' | 'remoteok' | 'remotive' | 'weworkremotely' | 'hn_hiring'
  | 'freehire' | 'linkedin' | 'adzuna' | 'usajobs';
export type ConnectionStatus = 'ok' | 'degraded' | 'down' | 'waiting_session' | 'needs_key' | 'disabled';
export type FeedbackKind = 'idea' | 'concern' | 'comment' | 'update' | 'retro';

export interface Job {
  id: number;
  source: string;
  externalId: string | null;
  canonicalUrl: string;
  company: string;
  title: string;
  location: string | null;
  remoteType: RemoteType;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPredicted: boolean;
  descriptionMd: string | null;
  postedAt: string | null;      // ISO dates throughout
  firstSeen: string;
  status: JobStatus;
  fitScore: number | null;      // 0-100 weighted
  fitBreakdown: { technical: number; experience: number; behavioral: number; career: number; locationVeto: boolean; note?: string } | null;
  legitVerdict: LegitVerdict;
  legitReasons: string[];
  managed: 'auto' | 'manual';
  /** Expected-value rank: salaryMid × (fitScore/100)^1.5 (×0.85 when the salary
   *  is predicted). Only populated by GET /api/jobs/top; null when unscored. */
  opportunityScore?: number | null;
}

/**
 * A screening answer the system refuses to invent. Replaces the legacy
 * "FLAGGED_FOR_USER" sentinel string: the UI renders it as an editable
 * "Needs your answer" field instead of leaking a magic token into the PDF.
 */
export interface NeedsUserAnswer {
  status: 'needs_user';
  /** The question as the form (or the defaults table) phrased it. */
  question: string;
  /** Why it is unanswerable and what would resolve it. */
  hint?: string;
  /** A non-binding suggestion the user may accept; never auto-used. */
  suggestion?: string;
  /** Standing-answer key that permanently resolves this question, when one exists. */
  standingKey?: StandingAnswerKey;
}

/** Stored screening answer: a plain string, or a structured needs-user marker. */
export type ScreeningAnswerValue = string | NeedsUserAnswer;

/** Legacy sentinel kept for reading rows written before structured markers. */
export const LEGACY_FLAGGED_ANSWER = 'FLAGGED_FOR_USER';

export function isNeedsUserAnswer(v: ScreeningAnswerValue | undefined | null): v is NeedsUserAnswer {
  return typeof v === 'object' && v !== null && (v as NeedsUserAnswer).status === 'needs_user';
}

/**
 * A note the drafter/reviewer left about THIS application: a gap between the
 * posting and the profile, a claim nobody could verify, a compensation or
 * location caveat. Advisories are transparency, not homework — they are never
 * questions, never block approval, and never reach a form field. They live
 * outside `Application.answers` precisely so they cannot be mistaken for one.
 */
export type AdvisoryKind = 'gap' | 'unverified' | 'compensation' | 'location' | 'other';

export interface Advisory {
  kind: AdvisoryKind;
  text: string;
}

/** Section headings for the review modal's read-only notes list. */
export const ADVISORY_KIND_LABELS: Record<AdvisoryKind, string> = {
  gap: 'Profile gaps',
  unverified: 'Unverified claims',
  compensation: 'Compensation',
  location: 'Location and travel',
  other: 'Other notes',
};

/** Stable render order for the grouped notes list. */
export const ADVISORY_KIND_ORDER: AdvisoryKind[] = ['gap', 'compensation', 'location', 'unverified', 'other'];

export function isAdvisory(v: unknown): v is Advisory {
  return typeof v === 'object' && v !== null && typeof (v as Advisory).text === 'string';
}

export type StandingAnswerKey =
  | 'salaryExpectation'
  | 'salaryMinAcceptable'
  | 'earliestStartDate'
  | 'noticePeriod'
  | 'citizenshipStatus'
  | 'requiresSponsorship'
  | 'securityClearance'
  | 'eeoRace'
  | 'eeoGender'
  | 'eeoVeteran'
  | 'eeoDisability'
  | 'willingToRelocate'
  | 'preferredPronouns'
  | 'referencesAvailable';

/**
 * Answers the user gives once and Homer reuses on every application (FR-9).
 * Everything is user-authored: nothing here is ever derived or invented by an
 * agent. Empty string = unset, which keeps the matching question flagged.
 * Stored as normal data — a `db`-scope reset wipes it.
 */
export interface StandingAnswers {
  salaryExpectation: string;
  /** Optional numeric floor; null = not disclosed. */
  salaryMinAcceptable: number | null;
  earliestStartDate: string;
  noticePeriod: string;
  citizenshipStatus: string;
  /** 'yes' | 'no' | '' */
  requiresSponsorship: string;
  securityClearance: string;
  eeoRace: string;
  eeoGender: string;
  eeoVeteran: string;
  eeoDisability: string;
  /** 'yes' | 'no' | free text | '' */
  willingToRelocate: string;
  preferredPronouns: string;
  referencesAvailable: string;
}

/**
 * Option sets for the enum-ish standing answers. The dashboard renders these as
 * dropdowns; the server canonicalizes any typed value against the same list, so
 * "no", "No" and "NO" all land on the same stored value instead of erroring.
 * A key absent here is free text by design (salary expectation, citizenship,
 * pronouns, references).
 *
 * `requiresSponsorship` is the one strictly enumerated key: it is stored
 * lowercase ('' | 'yes' | 'no') because the apply driver matches on it.
 */
export const STANDING_ANSWER_OPTIONS = {
  requiresSponsorship: ['yes', 'no'],
  willingToRelocate: ['Yes, anywhere in the US', 'Yes, within my region', 'No', 'Open to discuss'],
  securityClearance: ['None', 'Active Secret', 'Active Top Secret', 'Other'],
  noticePeriod: ['None', '1 week', '2 weeks', '1 month', 'Other'],
  earliestStartDate: [
    'Immediately',
    'One week from offer',
    'Two weeks from offer',
    'One month from offer',
    'Specific date',
  ],
  eeoRace: [
    'American Indian or Alaska Native',
    'Asian',
    'Black or African American',
    'Hispanic or Latino',
    'Native Hawaiian or Other Pacific Islander',
    'White',
    'Two or more races',
    'Decline to self-identify',
  ],
  eeoGender: ['Male', 'Female', 'Non-binary', 'Decline to self-identify'],
  eeoVeteran: [
    'I am not a protected veteran',
    'I identify as one or more classifications of a protected veteran',
    'Decline to self-identify',
  ],
  eeoDisability: [
    'Yes, I have a disability, or have had one in the past',
    'No, I do not have a disability and have not had one in the past',
    'Decline to self-identify',
  ],
} as const satisfies Partial<Record<StandingAnswerKey, readonly string[]>>;

export type EnumishStandingKey = keyof typeof STANDING_ANSWER_OPTIONS;

export interface Application {
  id: number;
  jobId: number;
  job?: Job;
  status: JobStatus;
  gate: GateMode;
  approvedAt: string | null;
  submittedAt: string | null;
  resumePath: string | null;
  coverLetterPath: string | null;
  /** REAL form questions only. Advisory notes never live here (see `advisories`). */
  answers: Record<string, ScreeningAnswerValue> | null;
  /** Read-only drafting notes: gaps, unverified claims, comp/location caveats. */
  advisories: Advisory[];
  archiveDir: string | null;
  notes: { date: string; text: string }[];
  /** True when the submit gate approved this without a human click (FR-9/D1). */
  autoSubmitted: boolean;
}

/**
 * Result of `POST /api/applications/:id/approve` (FR-9/D1).
 *
 * Approving is idempotent: a second click returns the apply task the first one
 * created rather than enqueueing another (submitting the same application to
 * the employer twice is unrecoverable). Everything the card and the toast need
 * to say what actually happens next rides along, including whether the queue is
 * paused — approval succeeding while nothing can run is the exact confusion
 * this shape exists to remove.
 */
export interface ApproveResult {
  /** The apply task that owns this submission — the same id on every replay. */
  taskId: number;
  taskState: TaskState;
  /** true → an apply task already existed; no new one was enqueued. */
  alreadyQueued: boolean;
  /** Tasks ahead of this one; 0 = next up. */
  queuePosition: number;
  /** Global pause flag: approved work sits still until the queue resumes. */
  queuePaused: boolean;
  /** The application after approval, so the card can update without a refetch. */
  application: Application;
}

export interface QueueTask {
  id: number;
  type: TaskType;
  state: TaskState;
  payload: Record<string, unknown>;
  cursor: Record<string, unknown> | null;  // resume point (source, page, item index)
  /** Claim order: higher first, FIFO within a priority. 10 = user-initiated,
   *  5 = auto-advance, 0 = bulk/background. */
  priority: number;
  runAfter: string | null;
  attempts: number;
  lastError: string | null;
  humanPrompt: string | null;              // what the user must do when needs_human
  createdAt: string;
  updatedAt: string;
}

export interface SourceBudget {
  source: string;
  health: 'ok' | 'degraded' | 'down';
  remainingTokens: number;
  refillPerHour: number;
  lastRun: string | null;
  nextRun: string | null;
  /** User-controlled: whether scheduled discovery may use this source. */
  enabled: boolean;
  /** Source needs an API key before it can run at all (adzuna, usajobs). */
  keyGated?: boolean;
  /** Set when the source cannot run despite `enabled` (missing key, skill not installed). */
  blockedReason?: string | null;
}

export interface EmailRecord {
  id: number;
  threadKey: string;
  direction: EmailDirection;
  classification: EmailClass;
  applicationId: number | null;
  subject: string;
  summary: string;
  bodyMd: string | null;
  needsApproval: boolean;
  approvedAt: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  /** Why this email is linked where it is; null when nothing linked it. */
  matchBasis: EmailMatchBasis | null;
  /** Non-empty only when matching was ambiguous — the Inbox asks which one. */
  matchCandidates: EmailMatchCandidate[];
}

export interface ScheduleEvent {
  id: number;
  type: 'interview' | 'deadline' | 'followup_due' | 'prep' | 'other';
  applicationId: number | null;
  title: string;
  startsAt: string;
  endsAt: string | null;
  prepGuidePath: string | null;
  company: string | null;
}

export interface PrepTask {
  id: number;
  eventId: number;
  skillTag: string | null;
  text: string;
  doneAt: string | null;
}

export interface SkillProgress {
  skill: string;
  totalTasks: number;
  doneTasks: number;
  evidence: string[];
}

export interface CredentialMeta {
  site: string;
  username: string;
  maskedPassword: string;   // e.g. "••••••••"
  hasCaptcha: boolean;
  notes: string | null;
  createdAt: string;
}

export interface Connection {
  name: ConnectionName;
  status: ConnectionStatus;
  detail: string | null;
  lastOk: string | null;
}

export interface UserProfile {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  links: { label: string; url: string }[];
  documents: { name: string; path: string; modifiedAt: string }[];
  country: string;          // active job market, ISO-2 (e.g. "US")
  profileReady: boolean;    // false while CLAUDE.md / candidate-profile skill still hold placeholder tokens
}

export interface FeedbackEntry {
  id: number;
  kind: FeedbackKind;
  inputMd: string;
  responseMd: string | null;
  planChange: { description: string; applied: boolean } | null;
  createdAt: string;
}

export interface Settings {
  gateMode: GateMode;
  hybridThreshold: number;          // fit score for hybrid auto-submit
  discoveryIntervalMinutes: number;
  emailScanIntervalMinutes: number;
  country: string;
  applyDriver: 'playwright' | 'chrome';
  perSourceGates: Record<string, GateMode>;   // e.g. { linkedin: 'review' }
  followupAfterDays: number;
  maxFollowups: number;
  /** Per-task model routing — cheaper models burn less subscription usage.
   *  'default' (the user's own Claude Code model, possibly Opus) is selectable
   *  but is no task's default. Haiku for high-volume triage, Sonnet where
   *  writing quality matters. (modelPipeline was split into the six granular
   *  keys below; a legacy modelPipeline settings row seeds all six once.) */
  modelAsk: ModelChoice;        // ask-anything chat (default 'haiku')
  modelSetup: ModelChoice;      // dashboard profile setup sessions (default 'sonnet')
  modelScraper: ModelChoice;    // search-queries regeneration (default 'haiku')
  modelScore: ModelChoice;      // fit scoring + legitimacy verification (default 'haiku')
  modelTailor: ModelChoice;     // resume/cover drafter AND reviewer (default 'sonnet')
  modelPrep: ModelChoice;       // interview prep guides (default 'sonnet')
  modelEmail: ModelChoice;      // email scan + send drafting (default 'haiku')
  modelFollowup: ModelChoice;   // follow-up email drafting (default 'sonnet')
  modelFeedback: ModelChoice;   // feedback / retro analysis (default 'sonnet')
  /** Auto-advance screened jobs into the tailor pipeline (FR-9). */
  autoAdvance: 'off' | 'threshold' | 'all';   // default 'threshold'
  autoAdvanceThreshold: number;               // fit score gate for 'threshold' mode (default 70)
  /** Max agent-bound tasks the queue runner keeps in flight at once (1-4).
   *  apply and discover are always serialized outside this pool. */
  queueConcurrency: number;                   // default 2
  /**
   * Layered on the submit gate (D1): when every screening answer resolved from
   * the profile + standing answers, fit/legitimacy passed and the ATS check
   * passed, submit without a review card. Anything unresolved still waits.
   * LinkedIn is always review-gated regardless. Default true.
   */
  autoSubmitWhenResolved: boolean;
}

/** Next scheduled sweep times (ISO) — part of the queue snapshot. */
export interface ScheduleNextRuns {
  discover: string | null;
  emailScan: string | null;
  followup: string | null;
}

// ---- SSE events (GET /api/events, text/event-stream) ----
export type SseEvent =
  | { type: 'job.discovered'; job: Job }
  | { type: 'job.scored'; job: Job }
  | { type: 'application.updated'; application: Application }
  | { type: 'queue.updated'; task: QueueTask }
  | { type: 'queue.snapshot'; tasks: QueueTask[]; budgets: SourceBudget[]; paused: boolean; nextRuns?: ScheduleNextRuns }
  | { type: 'task.needs_human'; task: QueueTask }
  | { type: 'email.received'; email: EmailRecord }
  | { type: 'outbox.updated'; email: EmailRecord }
  | { type: 'connection.updated'; connection: Connection }
  | { type: 'schedule.updated'; event: ScheduleEvent }
  | { type: 'ask.delta'; requestId: string; delta: string; done: boolean }
  | { type: 'setup.delta'; requestId: string; delta: string; done: boolean }
  | { type: 'toast'; level: 'info' | 'success' | 'warning' | 'error'; message: string; celebrate?: boolean };
