// Drizzle schema — mirrors migrations/0001_init.sql exactly (PRD §7).
import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source').notNull(),
    externalId: text('external_id'),
    canonicalUrl: text('canonical_url').notNull().default(''),
    company: text('company').notNull(),
    title: text('title').notNull(),
    location: text('location'),
    remoteType: text('remote_type').notNull().default('unknown'),
    salaryMin: real('salary_min'),
    salaryMax: real('salary_max'),
    salaryCurrency: text('salary_currency'),
    salaryPredicted: integer('salary_predicted').notNull().default(0),
    descriptionMd: text('description_md'),
    rawJson: text('raw_json'),
    postedAt: text('posted_at'),
    firstSeen: text('first_seen').notNull(),
    status: text('status').notNull().default('discovered'),
    fitScore: integer('fit_score'),
    fitBreakdownJson: text('fit_breakdown_json'),
    legitVerdict: text('legit_verdict').notNull().default('unchecked'),
    legitReasonsJson: text('legit_reasons_json').notNull().default('[]'),
    managed: text('managed').notNull().default('auto'),
    /** ApplyChannel — ats_form | aggregator_redirect | email | unknown (0006). */
    applyChannel: text('apply_channel').notNull().default('unknown'),
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => [
    uniqueIndex('jobs_dedupe_key_unique').on(t.dedupeKey),
    index('idx_jobs_status').on(t.status),
    index('idx_jobs_source').on(t.source),
    index('idx_jobs_apply_channel').on(t.applyChannel),
  ],
);

export const applications = sqliteTable(
  'applications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id').notNull(),
    status: text('status').notNull().default('tailoring'),
    gate: text('gate').notNull().default('review'),
    approvedAt: text('approved_at'),
    submittedAt: text('submitted_at'),
    resumePath: text('resume_path'),
    coverLetterPath: text('cover_letter_path'),
    answersJson: text('answers_json'),
    /** Advisory[] — drafting notes. Never questions, never gates anything. */
    advisoriesJson: text('advisories_json').notNull().default('[]'),
    auditJson: text('audit_json').notNull().default('[]'),
    archiveDir: text('archive_dir'),
    notesJson: text('notes_json').notNull().default('[]'),
    autoSubmitted: integer('auto_submitted').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_applications_job').on(t.jobId)],
);

/** "Answer once, reuse forever" screening answers (FR-9). User-authored only. */
export const standingAnswers = sqliteTable('standing_answers', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const emails = sqliteTable('emails', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  threadKey: text('thread_key').notNull(),
  direction: text('direction').notNull(),
  classification: text('classification').notNull().default('other'),
  applicationId: integer('application_id'),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  bodyMd: text('body_md'),
  needsApproval: integer('needs_approval').notNull().default(0),
  approvedAt: text('approved_at'),
  sentAt: text('sent_at'),
  receivedAt: text('received_at'),
  /** Strongest signal behind the application link: url | company_title | company | manual. */
  matchBasis: text('match_basis'),
  /** EmailMatchCandidate[] — the applications an ambiguous email could belong to. */
  matchCandidatesJson: text('match_candidates_json').notNull().default('[]'),
});

export const followups = sqliteTable('followups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  applicationId: integer('application_id').notNull(),
  dueAt: text('due_at').notNull(),
  draftMd: text('draft_md'),
  status: text('status').notNull().default('pending'),
});

export const scheduleEvents = sqliteTable('schedule_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull().default('other'),
  applicationId: integer('application_id'),
  title: text('title').notNull(),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at'),
  prepGuidePath: text('prep_guide_path'),
  company: text('company'),
});

export const prepTasks = sqliteTable('prep_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: integer('event_id').notNull(),
  skillTag: text('skill_tag'),
  text: text('text').notNull(),
  doneAt: text('done_at'),
});

export const skillsProgress = sqliteTable('skills_progress', {
  skill: text('skill').primaryKey(),
  level: integer('level').notNull().default(0),
  evidenceJson: text('evidence_json').notNull().default('[]'),
});

export const taskQueue = sqliteTable(
  'task_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    state: text('state').notNull().default('pending'),
    cursorJson: text('cursor_json'),
    priority: integer('priority').notNull().default(0),
    runAfter: text('run_after'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    humanPrompt: text('human_prompt'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_task_queue_state').on(t.state, t.runAfter)],
);

export const sourceBudgets = sqliteTable('source_budgets', {
  source: text('source').primaryKey(),
  tokens: real('tokens').notNull(),
  capacity: real('capacity').notNull(),
  refillPerHour: real('refill_per_hour').notNull(),
  lastRefill: text('last_refill'),
  lastRun: text('last_run'),
  nextRun: text('next_run'),
  health: text('health').notNull().default('ok'),
  enabled: integer('enabled').notNull().default(1),
});

export const credentialsMeta = sqliteTable('credentials_meta', {
  site: text('site').primaryKey(),
  username: text('username').notNull().default(''),
  vaultRef: text('vault_ref').notNull(),
  hasCaptcha: integer('has_captcha').notNull().default(0),
  notes: text('notes'),
  createdAt: text('created_at').notNull(),
});

export const connections = sqliteTable('connections', {
  name: text('name').primaryKey(),
  status: text('status').notNull().default('down'),
  detail: text('detail'),
  lastOk: text('last_ok'),
});

export const feedback = sqliteTable('feedback', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  inputMd: text('input_md').notNull(),
  responseMd: text('response_md'),
  planChangeJson: text('plan_change_json'),
  createdAt: text('created_at').notNull(),
});

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
