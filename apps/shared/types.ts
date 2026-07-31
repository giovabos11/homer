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
export type EmailClass = 'reply_accepted' | 'reply_rejected' | 'interview_invite' | 'opportunity' | 'followup' | 'other';
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
  answers: Record<string, ScreeningAnswerValue> | null;
  archiveDir: string | null;
  notes: { date: string; text: string }[];
  /** True when the submit gate approved this without a human click (FR-9/D1). */
  autoSubmitted: boolean;
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
