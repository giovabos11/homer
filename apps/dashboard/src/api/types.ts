import type {
  Advisory, Application, Connection, ConnectionName, CredentialMeta, EmailRecord, FeedbackEntry,
  FeedbackKind, Job, JobStatus, PrepTask, QueueTask, RemoteType, ScheduleEvent,
  ScheduleNextRuns, ScreeningAnswerValue, Settings, SkillProgress, SourceBudget,
  StandingAnswerKey, StandingAnswers, TaskType, UserProfile,
} from '@shared';

export interface JobsQuery {
  q?: string;
  status?: JobStatus | JobStatus[];
  source?: string;
  remote?: RemoteType;
  minScore?: number;
  legit?: string;
  sort?: 'salary' | 'score' | 'date';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchBody {
  keywords: string;
  experience?: string;
  remote?: RemoteType;
  location?: string;
  sources?: string[];
}

export interface QueueSnapshot {
  tasks: QueueTask[];
  budgets: SourceBudget[];
  paused: boolean;
  nextRuns?: ScheduleNextRuns;
}

export interface ApplicationArtifacts {
  resumeUrl: string | null;
  coverLetterUrl: string | null;
  screenshots: string[];
  /** Real form questions only. */
  answers: Record<string, ScreeningAnswerValue> | null;
  /** Read-only drafting notes: gaps, unverified claims, comp/location caveats. */
  advisories?: Advisory[];
}

export interface StandingAnswersResponse {
  answers: StandingAnswers;
  missingCritical: StandingAnswerKey[];
}

export interface AnswersPatchResult {
  application: Application;
  unresolved: string[];
  savedAsStanding: StandingAnswerKey[];
}

export interface GmailProbeResult {
  connection: Connection | null;
  available: boolean;
  toolCount: number;
  detail: string;
}

export interface SetupStatus {
  active: boolean;
  mode: 'interview' | 'documents' | null;
}

export interface Api {
  health(): Promise<{ ok: boolean; version: string }>;
  // connections
  getConnections(): Promise<Connection[]>;
  setConnectionKey(name: ConnectionName, key: string, appId?: string): Promise<Connection>;
  checkConnection(name: ConnectionName): Promise<Connection>;
  probeGmail(): Promise<GmailProbeResult>;
  // profile
  getProfile(): Promise<UserProfile>;
  patchProfile(body: { name?: string; email?: string; phone?: string }): Promise<UserProfile>;
  getProfileFile(path: string): Promise<{ path: string; content: string }>;
  putProfileFile(path: string, content: string): Promise<{ ok: boolean }>;
  regenerateQueries(): Promise<{ requestId: string }>;
  getArtifact(path: string): Promise<{ path: string; markdown: string }>;
  // profile setup chat
  setupStart(mode: 'interview' | 'documents'): Promise<{ requestId: string }>;
  setupMessage(text: string): Promise<{ requestId: string }>;
  setupStatus(): Promise<SetupStatus>;
  setupClear(): Promise<{ ok: boolean }>;
  // jobs
  getJobs(params?: JobsQuery): Promise<{ total: number; jobs: Job[] }>;
  getJob(id: number): Promise<Job>;
  getTopJobs(by: 'opportunity' | 'salary', limit?: number): Promise<Job[]>;
  createJob(body: Partial<Job>): Promise<Job>;
  applyFromUrl(url: string): Promise<{ job: Job; taskId: number; queuePosition?: number }>;
  applyJob(id: number): Promise<{ taskId: number; queuePosition?: number }>;
  fetchJobDetails(id: number): Promise<{ job: Job }>;
  skipJob(id: number): Promise<Job>;
  overrideLegit(id: number, note: string): Promise<{ job: Job; taskId: number | null }>;
  // applications
  getApplications(params?: { status?: string; q?: string; limit?: number; offset?: number }): Promise<{ total: number; applications: Application[] }>;
  patchApplication(id: number, body: { status?: JobStatus; notes?: string }): Promise<Application>;
  approveApplication(id: number): Promise<{ taskId: number }>;
  rejectApplication(id: number, reason: string): Promise<Application>;
  getApplicationArtifacts(id: number): Promise<ApplicationArtifacts>;
  patchApplicationAnswers(
    id: number,
    body: { answers: Record<string, string>; saveStanding?: string[] },
  ): Promise<AnswersPatchResult>;
  // standing answers
  getStandingAnswers(): Promise<StandingAnswersResponse>;
  putStandingAnswers(body: Partial<StandingAnswers>): Promise<StandingAnswersResponse>;
  // discovery sources
  getSources(): Promise<SourceBudget[]>;
  setSourceEnabled(source: string, enabled: boolean): Promise<SourceBudget>;
  // search & queue
  search(body: SearchBody): Promise<{ searchId: string }>;
  getQueue(): Promise<QueueSnapshot>;
  runDiscovery(): Promise<{ taskId: number }>;
  pauseQueue(): Promise<QueueSnapshot>;
  resumeQueue(): Promise<QueueSnapshot>;
  setQueueRate(discoveryIntervalMinutes: number): Promise<Settings>;
  resolveHuman(taskId: number, answers?: Record<string, string>): Promise<QueueTask>;
  retryTask(taskId: number): Promise<QueueTask>;
  cancelTask(taskId: number): Promise<QueueTask>;
  cancelAll(scope: 'running' | 'pending' | 'all', type?: TaskType): Promise<{ cancelled: number }>;
  retryFailed(type?: TaskType): Promise<{ requeued: number }>;
  // emails
  getEmails(params?: { direction?: string; classification?: string; limit?: number; offset?: number }): Promise<{ total: number; emails: EmailRecord[] }>;
  getOutbox(): Promise<EmailRecord[]>;
  approveOutbox(id: number): Promise<EmailRecord>;
  rejectOutbox(id: number, reason?: string): Promise<EmailRecord>;
  triggerEmailScan(): Promise<{ taskId: number }>;
  // schedule & skills
  getSchedule(from?: string, to?: string): Promise<ScheduleEvent[]>;
  createScheduleEvent(body: Partial<ScheduleEvent>): Promise<ScheduleEvent>;
  regenPrep(eventId: number): Promise<{ taskId: number }>;
  getPrepTasks(eventId?: number): Promise<PrepTask[]>;
  patchPrepTask(id: number, done: boolean): Promise<PrepTask>;
  getSkillsProgress(): Promise<SkillProgress[]>;
  // credentials
  getCredentials(): Promise<CredentialMeta[]>;
  addCredential(body: { site: string; username: string; password: string; hasCaptcha?: boolean; notes?: string }): Promise<CredentialMeta>;
  revealCredential(site: string): Promise<{ password: string }>;
  deleteCredential(site: string): Promise<{ ok: boolean }>;
  // feedback / ask / settings / reset
  postFeedback(kind: FeedbackKind, text: string): Promise<FeedbackEntry>;
  getFeedback(): Promise<FeedbackEntry[]>;
  deleteFeedback(id: number): Promise<{ ok: boolean }>;
  clearFeedback(kind?: FeedbackKind): Promise<{ deleted: number }>;
  applyPlanChange(id: number): Promise<FeedbackEntry>;
  ask(prompt: string): Promise<{ requestId: string }>;
  askClear(): Promise<{ ok: boolean }>;
  getSettings(): Promise<Settings>;
  patchSettings(body: Partial<Settings>): Promise<Settings>;
  resetPreview(scopes: string[]): Promise<{ preview: string[] }>;
  reset(scopes: string[]): Promise<{ ok: boolean }>;
}
