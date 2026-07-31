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
  answers: Record<string, string> | null;
  archiveDir: string | null;
  notes: { date: string; text: string }[];
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
  enabled: boolean;
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
