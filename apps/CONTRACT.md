# API Contract — apps/server ⇄ apps/dashboard

Server: `http://localhost:4750` (localhost only). Dashboard dev server: Vite on `5173` with proxy `/api → 4750`.
All request/response shapes use the types in `apps/shared/types.ts`. All responses JSON; errors: `{ error: string, detail?: string }` with 4xx/5xx.

## Health & connections
- `GET  /api/health` → `{ ok: true, version: string }`
- `GET  /api/connections` → `Connection[]`
- `POST /api/connections/:name/key` body `{ key: string, appId?: string }` → stores in vault, re-checks → `Connection`  (adzuna, usajobs)
- `POST /api/connections/:name/check` → `Connection` (re-probe health)
- `POST /api/connections/gmail/probe` → `{ connection: Connection, available: boolean, toolCount: number, detail: string }` — runs a tiny headless agent call (haiku) that reports whether the claude.ai Gmail MCP tools are reachable; updates the gmail card + emits `connection.updated`. Headless sessions usually report unavailable (Gmail is session-only by design).

## Profile & documents
- `GET  /api/profile` → `UserProfile` (identity auto-extracted from profile docs; `profileReady:false` while `CLAUDE.md` or the candidate-profile skill file still contain the literal placeholder tokens `[PLACEHOLDER`/`[YOUR_` — drives the dashboard's first-run onboarding card)
- `PATCH /api/profile` body `{ name?, email?, phone? }` → `UserProfile` — contact overrides stored server-side (settings-level); preferred over values extracted from profile files, so they work even before setup. Email/phone validated.
- `GET  /api/profile/files?path=<rel>` → `{ path, content }` — profile file editor read. STRICT safe-list: `documents/**` with `.md`/`.txt` extension, `.claude/skills/job-application-assistant/*.md`, or exactly `CLAUDE.md`. Traversal (`..`), absolute paths, and other extensions → 400.
- `PUT  /api/profile/files` body `{ path, content }` → `{ ok: true }` — same safe-list; `profileReady` recomputes on the next `GET /api/profile` (the dashboard refetches after save). `documents/` edits additionally wake the file watcher's profile re-sync.
- `POST /api/profile/regenerate-queries` → `{ requestId }` — queues a `regen_queries` task (modelScraper) that rewrites `.claude/skills/job-scraper/search-queries.md` from the current profile, preserving that file's structural format. Completion is announced via toast. Deduped while one is pending/running.
- `GET  /api/artifacts?path=<relative>` → `{ path, markdown }` — safe-listed roots only: `documents/`, `upskill/`, application archives.

## Profile setup (dashboard chat — upstream `/setup` semantics)
- `POST /api/setup/start` body `{ mode: 'interview' | 'documents' }` → `{ requestId }` — starts a fresh setup agent session (modelSetup; tools Read/Glob/Grep/Edit/Write, no web). `documents` = upstream Path A (scan `documents/`, cross-reference, additive changes, surface conflicts); `interview` = upstream Path C (conversational interview, one section at a time). The agent may only edit `CLAUDE.md` and the job-application-assistant skill files 01/02/04/05/07/08.
- `POST /api/setup/message` body `{ text }` → `{ requestId }` — continues the stored session (`claude --resume`); 409 when no session is active.
- `GET  /api/setup/status` → `{ active: boolean, mode: 'interview' | 'documents' | null }` — whether a resumable session exists (survives server restarts).
- `POST /api/setup/clear` → `{ ok: true }` — drops the stored session id (fresh start next time).
- Assistant output streams as `setup.delta` SSE events `{ requestId, delta, done }`. When a turn completes and `profileReady` flips true, the server toasts (with celebrate) and suggests query regeneration; the dashboard refetches `/api/profile` on `done`.

## Jobs
- `GET  /api/jobs?q&status&source&remote&minScore&legit&sort=(salary|score|date)&order&limit&offset` → `{ total: number, jobs: Job[] }`
- `GET  /api/jobs/:id` → `Job` (includes `descriptionMd`)
- `GET  /api/jobs/top?by=salary&fitWeighted=(true|false)&limit=10` → `Job[]`  (FR-17)
- `POST /api/jobs` body `Partial<Job>` (company, title, descriptionMd, status, …) → `Job` with `managed:'manual'`  (FR-5)
- `POST /api/jobs/from-url` body `{ url: string }` → `{ job: Job, taskId: number }` — parses, saves, scores, enters apply pipeline (FR-4)
- `POST /api/jobs/:id/apply` → `{ taskId }` — start tailoring+apply for a discovered job (manual override; screened jobs that clear the `autoAdvance` gate enter tailoring automatically after scoring)
- `POST /api/jobs/:id/fetch-details` → `{ job: Job }` — on-demand description backfill: runs the source portal's `detail` command; falls back to an agent (haiku + WebFetch) extraction of the canonical URL treated as untrusted data. Emits a `job.scored` SSE refresh.
- `POST /api/jobs/:id/skip` → `Job`

## Applications
- `GET  /api/applications?status&q&limit&offset` → `{ total: number, applications: Application[] }` (default limit 50, max 500; ordered by last update)
- `PATCH /api/applications/:id` body `{ status?, notes? }` → `Application` (kanban drag = status change)
- `POST /api/applications/:id/approve` → `{ taskId }` — user approval at the submit gate (FR-9/D1)
- `POST /api/applications/:id/reject` body `{ reason }` → `Application` (back to tailoring or skipped)
- `GET  /api/applications/:id/artifacts` → `{ resumeUrl, coverLetterUrl, screenshots: string[], answers }` (PDFs served under `/files/...`)

## Search & queue
- `POST /api/search` body `{ keywords, experience?, remote?: RemoteType, location?, sources?: string[] }` → `{ searchId }`; results stream as `job.discovered` SSE events  (FR-3)
- `GET  /api/queue` → `{ tasks: QueueTask[], budgets: SourceBudget[], paused: boolean }`
- `POST /api/queue/run-discovery` → `{ taskId }` — enqueue a discovery sweep immediately (budgets still respected); if a discover task is already pending/running, returns that task's id instead of enqueueing another
- `POST /api/queue/pause` / `POST /api/queue/resume` → queue snapshot
- `POST /api/queue/rate` body `{ discoveryIntervalMinutes }` → `Settings`
- `POST /api/queue/tasks/:id/resolve-human` → `QueueTask` (user did the manual step; worker resumes)  (FR-25)
- `POST /api/queue/tasks/:id/retry` / `POST /api/queue/tasks/:id/cancel` → `QueueTask`

## Emails & outbox
- `GET  /api/emails?direction&classification&limit&offset` → `{ total: number, emails: EmailRecord[] }` (default limit 50, max 500; newest first)  (FR-20)
- `GET  /api/outbox` → `EmailRecord[]` (drafts with `needsApproval:true`)
- `POST /api/outbox/:id/approve` → `EmailRecord` (queued for send in next session)  (FR-11)
- `POST /api/outbox/:id/reject` body `{ reason? }` → `EmailRecord`
- `POST /api/emails/scan` → `{ taskId }` (manual trigger of the periodic scan)

## Schedule, interviews & skills
- `GET  /api/schedule?from&to` → `ScheduleEvent[]`  (FR-12)
- `POST /api/schedule` body `Partial<ScheduleEvent>` → `ScheduleEvent`
- `POST /api/schedule/:id/prep` → `{ taskId }` — (re)generate study guide (FR-13)
- `GET  /api/prep-tasks?eventId` → `PrepTask[]`
- `PATCH /api/prep-tasks/:id` body `{ done: boolean }` → `PrepTask`  (FR-21)
- `GET  /api/skills-progress` → `SkillProgress[]`  (FR-23)

## Credentials
- `GET  /api/credentials` → `CredentialMeta[]` (masked)  (FR-30)
- `POST /api/credentials` body `{ site, username, password, hasCaptcha?, notes? }` → `CredentialMeta`
- `POST /api/credentials/:site/reveal` → `{ password }` (localhost only; logged)
- `DELETE /api/credentials/:site` → `{ ok }`

## Feedback, ask, settings, reset
- `POST /api/feedback` body `{ kind: FeedbackKind, text }` → `FeedbackEntry` (response fills in async; `feedback.updated` via toast/SSE)  (FR-26/27)
- `GET  /api/feedback` → `FeedbackEntry[]`
- `POST /api/feedback/:id/apply-plan` → `FeedbackEntry` (applies proposed plan change)
- `POST /api/ask` body `{ prompt }` → `{ requestId }`; stream via `ask.delta` SSE events  (FR-29). Conversational: the server stores the ask session id and resumes it on every ask.
- `POST /api/ask/clear` → `{ ok: true }` — drops the stored ask session; the next ask starts a fresh conversation.
- `GET  /api/settings` / `PATCH /api/settings` body `Partial<Settings>` → `Settings` — includes the per-task model routing keys `modelAsk` (default `haiku`), `modelSetup` (default `sonnet`), `modelScraper` (default `sonnet`), `modelPipeline` (default `sonnet`); values `default | haiku | sonnet | opus` (`default` = the user's own Claude Code model, possibly Opus — selectable but no task's default). Also the pipeline auto-advance keys `autoAdvance` (`off | threshold | all`, default `threshold`) and `autoAdvanceThreshold` (default 70): screened jobs that are legit, not location-vetoed, and meet the gate flow into tailoring automatically; submission still obeys the submit gate.
- `POST /api/reset` body `{ confirmation: 'RESET', scopes: ('db'|'artifacts'|'profile')[] }` → `{ preview?: string[], ok?: true }`; call with `{ preview: true }` first to get the deletion preview  (FR-28)

## Events
- `GET /api/events` → `text/event-stream` of `SseEvent` (`event:` field = `type`, `data:` = JSON). Heartbeat comment every 15 s. Client reconnect-safe (server sends `queue.snapshot` + full connection list on connect).

## Static
- `GET /files/*` → generated artifacts (PDFs, screenshots) from the archives dir. Read-only.
