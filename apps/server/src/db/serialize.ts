// Row → shared API type mappers. Keeps snake_case/json-blob details out of the API layer.
import type {
  Application, Connection, CredentialMeta, EmailRecord, FeedbackEntry, Job,
  PrepTask, QueueTask, ScheduleEvent, SourceBudget,
} from '@shared/types';
import type {
  applications, connections, credentialsMeta, emails, feedback, jobs,
  prepTasks, scheduleEvents, sourceBudgets, taskQueue,
} from './schema';

type JobRow = typeof jobs.$inferSelect;
type ApplicationRow = typeof applications.$inferSelect;
type EmailRow = typeof emails.$inferSelect;
type ScheduleRow = typeof scheduleEvents.$inferSelect;
type PrepTaskRow = typeof prepTasks.$inferSelect;
type TaskRow = typeof taskQueue.$inferSelect;
type BudgetRow = typeof sourceBudgets.$inferSelect;
type CredentialRow = typeof credentialsMeta.$inferSelect;
type ConnectionRow = typeof connections.$inferSelect;
type FeedbackRow = typeof feedback.$inferSelect;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    canonicalUrl: row.canonicalUrl,
    company: row.company,
    title: row.title,
    location: row.location,
    remoteType: row.remoteType as Job['remoteType'],
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryCurrency: row.salaryCurrency,
    salaryPredicted: row.salaryPredicted === 1,
    descriptionMd: row.descriptionMd,
    postedAt: row.postedAt,
    firstSeen: row.firstSeen,
    status: row.status as Job['status'],
    fitScore: row.fitScore,
    fitBreakdown: parseJson<Job['fitBreakdown']>(row.fitBreakdownJson, null),
    legitVerdict: row.legitVerdict as Job['legitVerdict'],
    legitReasons: parseJson<string[]>(row.legitReasonsJson, []),
    managed: row.managed as Job['managed'],
  };
}

export function toApplication(row: ApplicationRow, job?: JobRow | null): Application {
  return {
    id: row.id,
    jobId: row.jobId,
    job: job ? toJob(job) : undefined,
    status: row.status as Application['status'],
    gate: row.gate as Application['gate'],
    approvedAt: row.approvedAt,
    submittedAt: row.submittedAt,
    resumePath: row.resumePath,
    coverLetterPath: row.coverLetterPath,
    answers: parseJson<Application['answers']>(row.answersJson, null),
    archiveDir: row.archiveDir,
    notes: parseJson<Application['notes']>(row.notesJson, []),
  };
}

export function toEmail(row: EmailRow): EmailRecord {
  return {
    id: row.id,
    threadKey: row.threadKey,
    direction: row.direction as EmailRecord['direction'],
    classification: row.classification as EmailRecord['classification'],
    applicationId: row.applicationId,
    subject: row.subject,
    summary: row.summary,
    bodyMd: row.bodyMd,
    needsApproval: row.needsApproval === 1,
    approvedAt: row.approvedAt,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
  };
}

export function toScheduleEvent(row: ScheduleRow): ScheduleEvent {
  return {
    id: row.id,
    type: row.type as ScheduleEvent['type'],
    applicationId: row.applicationId,
    title: row.title,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    prepGuidePath: row.prepGuidePath,
    company: row.company,
  };
}

export function toPrepTask(row: PrepTaskRow): PrepTask {
  return { id: row.id, eventId: row.eventId, skillTag: row.skillTag, text: row.text, doneAt: row.doneAt };
}

export function toQueueTask(row: TaskRow): QueueTask {
  return {
    id: row.id,
    type: row.type as QueueTask['type'],
    state: row.state as QueueTask['state'],
    payload: parseJson<Record<string, unknown>>(row.payloadJson, {}),
    cursor: parseJson<Record<string, unknown> | null>(row.cursorJson, null),
    runAfter: row.runAfter,
    attempts: row.attempts,
    lastError: row.lastError,
    humanPrompt: row.humanPrompt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSourceBudget(row: BudgetRow): SourceBudget {
  return {
    source: row.source,
    health: row.health as SourceBudget['health'],
    remainingTokens: Math.floor(row.tokens),
    refillPerHour: row.refillPerHour,
    lastRun: row.lastRun,
    nextRun: row.nextRun,
    enabled: row.enabled === 1,
  };
}

export function toCredentialMeta(row: CredentialRow): CredentialMeta {
  return {
    site: row.site,
    username: row.username,
    maskedPassword: '••••••••',
    hasCaptcha: row.hasCaptcha === 1,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

export function toConnection(row: ConnectionRow): Connection {
  return {
    name: row.name as Connection['name'],
    status: row.status as Connection['status'],
    detail: row.detail,
    lastOk: row.lastOk,
  };
}

export function toFeedbackEntry(row: FeedbackRow): FeedbackEntry {
  return {
    id: row.id,
    kind: row.kind as FeedbackEntry['kind'],
    inputMd: row.inputMd,
    responseMd: row.responseMd,
    planChange: parseJson<FeedbackEntry['planChange']>(row.planChangeJson, null),
    createdAt: row.createdAt,
  };
}
