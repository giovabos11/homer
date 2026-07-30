-- 0001_init: full schema per PRD §7
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT,
  canonical_url TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  remote_type TEXT NOT NULL DEFAULT 'unknown',
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT,
  salary_predicted INTEGER NOT NULL DEFAULT 0,
  description_md TEXT,
  raw_json TEXT,
  posted_at TEXT,
  first_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  fit_score INTEGER,
  fit_breakdown_json TEXT,
  legit_verdict TEXT NOT NULL DEFAULT 'unchecked',
  legit_reasons_json TEXT NOT NULL DEFAULT '[]',
  managed TEXT NOT NULL DEFAULT 'auto',
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'tailoring',
  gate TEXT NOT NULL DEFAULT 'review',
  approved_at TEXT,
  submitted_at TEXT,
  resume_path TEXT,
  cover_letter_path TEXT,
  answers_json TEXT,
  audit_json TEXT NOT NULL DEFAULT '[]',
  archive_dir TEXT,
  notes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  direction TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'other',
  application_id INTEGER REFERENCES applications(id),
  subject TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body_md TEXT,
  needs_approval INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  sent_at TEXT,
  received_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(direction);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  due_at TEXT NOT NULL,
  draft_md TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS schedule_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'other',
  application_id INTEGER REFERENCES applications(id),
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  prep_guide_path TEXT,
  company TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_starts ON schedule_events(starts_at);

CREATE TABLE IF NOT EXISTS prep_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES schedule_events(id),
  skill_tag TEXT,
  text TEXT NOT NULL,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS skills_progress (
  skill TEXT PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS task_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending',
  cursor_json TEXT,
  run_after TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  human_prompt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_queue_state ON task_queue(state, run_after);

CREATE TABLE IF NOT EXISTS source_budgets (
  source TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  capacity REAL NOT NULL,
  refill_per_hour REAL NOT NULL,
  last_refill TEXT,
  last_run TEXT,
  next_run TEXT,
  health TEXT NOT NULL DEFAULT 'ok',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS credentials_meta (
  site TEXT PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  vault_ref TEXT NOT NULL,
  has_captcha INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'down',
  detail TEXT,
  last_ok TEXT
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  input_md TEXT NOT NULL,
  response_md TEXT,
  plan_change_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
