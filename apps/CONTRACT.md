# API Contract — apps/server ⇄ apps/dashboard

Server: `http://localhost:4750` (localhost only). Dashboard dev server: Vite on `5173` with proxy `/api → 4750`.
All request/response shapes use the types in `apps/shared/types.ts`. All responses JSON; errors: `{ error: string, detail?: string }` with 4xx/5xx.

## Health & connections
- `GET  /api/health` → `{ ok: true, version: string }`
- `GET  /api/connections` → `Connection[]`
- `POST /api/connections/:name/key` body `{ key: string, appId?: string }` → stores in vault, re-checks → `Connection`  (adzuna, usajobs)
- `POST /api/connections/:name/check` → `Connection` (re-probe health)

## Profile & documents
- `GET  /api/profile` → `UserProfile` (identity auto-extracted from profile docs; `profileReady:false` while `CLAUDE.md` or the candidate-profile skill file still contain the literal placeholder tokens `[PLACEHOLDER`/`[YOUR_` — drives the dashboard's first-run onboarding card)
- `GET  /api/artifacts?path=<relative>` → `{ path, markdown }` — safe-listed roots only: `documents/`, `upskill/`, application archives.

## Jobs
- `GET  /api/jobs?q&status&source&remote&minScore&legit&sort=(salary|score|date)&order&limit&offset` → `{ total: number, jobs: Job[] }`
- `GET  /api/jobs/:id` → `Job` (includes `descriptionMd`)
- `GET  /api/jobs/top?by=salary&fitWeighted=(true|false)&limit=10` → `Job[]`  (FR-17)
- `POST /api/jobs` body `Partial<Job>` (company, title, descriptionMd, status, …) → `Job` with `managed:'manual'`  (FR-5)
- `POST /api/jobs/from-url` body `{ url: string }` → `{ job: Job, taskId: number }` — parses, saves, scores, enters apply pipeline (FR-4)
- `POST /api/jobs/:id/apply` → `{ taskId }` — start tailoring+apply for a discovered job
- `POST /api/jobs/:id/skip` → `Job`

## Applications
- `GET  /api/applications?status&q` → `Application[]`
- `PATCH /api/applications/:id` body `{ status?, notes? }` → `Application` (kanban drag = status change)
- `POST /api/applications/:id/approve` → `{ taskId }` — user approval at the submit gate (FR-9/D1)
- `POST /api/applications/:id/reject` body `{ reason }` → `Application` (back to tailoring or skipped)
- `GET  /api/applications/:id/artifacts` → `{ resumeUrl, coverLetterUrl, screenshots: string[], answers }` (PDFs served under `/files/...`)

## Search & queue
- `POST /api/search` body `{ keywords, experience?, remote?: RemoteType, location?, sources?: string[] }` → `{ searchId }`; results stream as `job.discovered` SSE events  (FR-3)
- `GET  /api/queue` → `{ tasks: QueueTask[], budgets: SourceBudget[], paused: boolean }`
- `POST /api/queue/pause` / `POST /api/queue/resume` → queue snapshot
- `POST /api/queue/rate` body `{ discoveryIntervalMinutes }` → `Settings`
- `POST /api/queue/tasks/:id/resolve-human` → `QueueTask` (user did the manual step; worker resumes)  (FR-25)
- `POST /api/queue/tasks/:id/retry` / `POST /api/queue/tasks/:id/cancel` → `QueueTask`

## Emails & outbox
- `GET  /api/emails?direction&classification` → `EmailRecord[]`  (FR-20)
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
- `POST /api/ask` body `{ prompt }` → `{ requestId }`; stream via `ask.delta` SSE events  (FR-29)
- `GET  /api/settings` / `PATCH /api/settings` body `Partial<Settings>` → `Settings`
- `POST /api/reset` body `{ confirmation: 'RESET', scopes: ('db'|'artifacts'|'profile')[] }` → `{ preview?: string[], ok?: true }`; call with `{ preview: true }` first to get the deletion preview  (FR-28)

## Events
- `GET /api/events` → `text/event-stream` of `SseEvent` (`event:` field = `type`, `data:` = JSON). Heartbeat comment every 15 s. Client reconnect-safe (server sends `queue.snapshot` + full connection list on connect).

## Static
- `GET /files/*` → generated artifacts (PDFs, screenshots) from the archives dir. Read-only.
