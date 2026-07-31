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
- `GET  /api/jobs/top?by=(opportunity|salary)&fitWeighted=(true|false)&limit=10` → `Job[]`  (FR-17). Default `by=opportunity`: expected-value ranking `opportunityScore = salaryMid × (fitScore/100)^1.5` where `salaryMid` = (min+max)/2 or the single bound; predicted salaries ×0.85; jobs with null `fitScore` rank below all scored jobs (salary desc among themselves); quarantined/skipped/rejected statuses and suspicious/scam verdicts excluded. Every row carries `opportunityScore` (null when unscored). `by=salary` keeps the raw ranking (`fitWeighted` still supported there).
- `POST /api/jobs` body `Partial<Job>` (company, title, descriptionMd, status, …) → `Job` with `managed:'manual'`  (FR-5)
- `POST /api/jobs/from-url` body `{ url: string }` → `{ job: Job, taskId: number, queuePosition: number }` — parses, saves, scores (priority 10), enters apply pipeline (FR-4); `queuePosition` = approx. running/queued tasks ahead
- `POST /api/jobs/:id/apply` → `{ taskId, queuePosition }` — start tailoring+apply for a discovered job (manual override; enqueued at priority 10 so it jumps the bulk score backlog; screened jobs that clear the `autoAdvance` gate enter tailoring automatically after scoring). The dashboard derives the card's "Queued for tailoring" badge from the pending/running tailor task for that job.
- `POST /api/jobs/:id/fetch-details` → `{ job: Job }` — on-demand description backfill: runs the source portal's `detail` command; falls back to an agent (haiku + WebFetch) extraction of the canonical URL treated as untrusted data. Emits a `job.scored` SSE refresh.
- `POST /api/jobs/:id/skip` → `Job` (scam-verdict jobs stay `quarantined` instead of `skipped` so they remain findable for manual review)

### Apply channel (`Job.applyChannel`)
Derived from the canonical URL (plus source and stored description) and persisted on the job (`jobs.apply_channel`, migration `0006`). It is what decides whether the pipeline can submit at all.

| Value | Meaning | What the apply worker does |
|---|---|---|
| `ats_form` | Greenhouse / Lever / Ashby / Workable / SmartRecruiters / Workday / … or a company careers page | verifies liveness, then drives the form |
| `aggregator_redirect` | a syndication redirect (`whatjobs.com/pub_api__…` and friends) | follows the redirect chain first; rewrites `canonicalUrl` when it reaches an employer form, otherwise `needs_manual` |
| `email` | HN "Who is hiring" threads, `mailto:`, or a posting whose only path is an address | drafts an approval-gated Outbox email; never opens a browser |
| `unknown` | no URL, or a link that cannot be classified | `needs_manual`; never submitted |

`isAutoApplyable(channel)` (shared) is true only for `ats_form`. `APPLY_CHANNEL_LABELS` / `APPLY_CHANNEL_HINTS` carry the badge copy. Classification runs at intake in `upsertJob` and is recomputed when an ATS sighting replaces an aggregator sighting; an idempotent boot backfill classifies pre-existing rows and adds a "cannot be auto-submitted" advisory to approved-but-unsubmitted applications whose channel is not `ats_form`.

### Pre-apply liveness and re-resolution
Before any form interaction the worker verifies the posting still exists, and **"dead posting" outranks every other diagnosis** (a stale Ashby id used to be reported as a reCAPTCHA wall because the "Job not found" shell's CSS mentions `.grecaptcha-badge`). For Ashby / Greenhouse / Lever the company board API is authoritative rather than scraping (`api.ashbyhq.com/posting-api/job-board/{slug}`, `boards-api.greenhouse.io/v1/boards/{token}/jobs`, `api.lever.co/v0/postings/{site}`); everything else uses HTTP status plus text heuristics. 401/403/429/5xx and network failures are **inconclusive, never expired**.

A dead posting on a queryable board is re-matched by normalized title (narrowed by location). One confident match → `canonicalUrl` + `externalId` are rewritten in place, an advisory records the change, and the apply continues. Ambiguity or a miss → the job becomes `expired` and the apply task fails **terminally** (no retry) with the board's current openings in the failure detail.

### New job statuses
`JobStatus` gained `expired` (the posting is gone and could not be re-resolved) and `needs_manual` (the link is real but is not an employer form Homer can drive). Both are accepted by `PATCH /api/applications/:id` and `POST /api/jobs`; `expired` is excluded from `GET /api/jobs/top`. The kanban renders them in a **Manual / expired** column immediately right of Ready for review, so a card that cannot be submitted stops implying that it is about to be.
- `POST /api/jobs/:id/override-legit` body `{ verdict: 'legit', note: string }` → `{ job: Job, taskId: number | null }` — manual legitimacy override after user review: verdict → legit with `[user override: <note>]` appended to `legitReasons`, status → `screened`; when the job has no `fitScore` yet a rescore task is enqueued (`taskId`). Structural signals alone cap at `suspicious` — a `scam` verdict (→ quarantine) requires the agent verification to concur; this endpoint is the human escape hatch for both.

## Applications
- `GET  /api/applications?status&q&limit&offset` → `{ total: number, applications: Application[] }` (default limit 50, max 500; ordered by last update)
- `PATCH /api/applications/:id` body `{ status?, notes? }` → `Application` (kanban drag = status change)
- `PATCH /api/applications/:id/answers` body `{ answers: Record<string,string>, saveStanding?: string[] }` → `{ application, unresolved: string[], savedAsStanding: StandingAnswerKey[] }` — edit the pre-drafted screening answers from the review modal. Blank values never clear a `needs_user` marker. Questions listed in `saveStanding` are also written to the standing answers (mapped to their standing key), so answering once fixes the question forever.
- `POST /api/applications/:id/approve` → `ApproveResult` `{ taskId, taskState, alreadyQueued, queuePosition, queuePaused, application }` — user approval at the submit gate (FR-9/D1). **Idempotent:** a second call returns the apply task the first one created (`alreadyQueued: true`, same `taskId`, HTTP 200) instead of enqueueing another — a duplicate apply task would submit to the employer twice. The first call owns `approvedAt` and the `gate.user_approved` audit line; replays leave both untouched. A fresh task is only enqueued once the previous one is no longer live (done/failed/cancelled), which is the retry path. **409 `answers_unresolved`** while any REAL question is still a `{ status: 'needs_user' }` marker (advisories never count — see below); **409 `already_submitted`** once `submittedAt` is set. `queuePaused` is why the dashboard can say "approved, but nothing runs until you resume" instead of looking like nothing happened.
- `POST /api/applications/:id/reject` body `{ reason }` → `Application` (back to tailoring or skipped)
- `GET  /api/applications/:id/artifacts` → `{ resumeUrl, coverLetterUrl, screenshots: string[], answers, advisories }` (PDFs served under `/files/...`). `answers` values are either a plain string or `{ status: 'needs_user', question, hint?, suggestion?, standingKey? }` — legacy rows holding the literal `FLAGGED_FOR_USER` sentinel are normalized to that marker on read.
- `Application.autoSubmitted` is true when the gate submitted without a human click (the Applied card shows a "Submitted automatically" marker).

### Answers vs advisories
`Application.answers` holds **real form questions only**. `Application.advisories` (`{ kind: 'gap'|'unverified'|'compensation'|'location'|'other', text }[]`, stored in `applications.advisories_json`) holds the drafter/reviewer's notes about that application: posting requirements the profile does not support, claims that could not be verified, compensation and location caveats. Advisories are read-only, are rendered under the questions in a collapsed "Notes from drafting" section, and **never** block approval, auto-submit or the apply driver. `PATCH /answers` ignores advisory keys.

Older builds wrote those notes into `answers_json` as `{ status: 'needs_user' }` markers keyed `FLAG: …`, alongside a catch-all row ("Skills, tools, or experience not in the profile") that is a policy statement rather than a question. Both are moved out at boot by an idempotent repair, and both are excluded from the unresolved/blocking calculation even if a row escapes it. The catch-all is dropped from `answers` on resolution and never re-created.

## Standing answers
"Answer once, reuse forever" values only the candidate can supply. Resolution order for every screening question: **standing answer → profile rule (the `Candidate screening defaults` table in `08-application-forms.md`, which the server only ever READS) → `needs_user` marker**. Stored in the `standing_answers` table as normal data: a `POST /api/reset` with scope `db` wipes it, and nothing is ever auto-populated.
- `GET /api/standing-answers` → `{ answers: StandingAnswers, missingCritical: StandingAnswerKey[] }` (`missingCritical` = salary / start date / work authorization still unset — drives the Home nudge)
- `PUT /api/standing-answers` body `Partial<StandingAnswers>` (partial patch, strict) → same shape. Keys: `salaryExpectation`, `salaryMinAcceptable` (number|null), `earliestStartDate`, `noticePeriod`, `citizenshipStatus`, `requiresSponsorship` (`''|yes|no`), `securityClearance`, `eeoRace|eeoGender|eeoVeteran|eeoDisability` (default `Prefer not to say`), `willingToRelocate`, `preferredPronouns`, `referencesAvailable`.
- **Validation is case-insensitive and value-normalizing.** `requiresSponsorship` accepts any casing or phrasing of yes/no ("No", "no", "NO", "None", "Yes, I will") and stores the lowercase form; only a genuinely different value (e.g. "maybe") is a 400. Every other enum-ish key is snapped onto its canonical option when the typed value matches one ignoring case and punctuation ("yes, anywhere in the us" → "Yes, anywhere in the US"), and free text is preserved when it matches nothing. The option lists live in `apps/shared/types.ts` as `STANDING_ANSWER_OPTIONS` and drive the dashboard's dropdowns.
- Salary resolution is job-aware: when the posting publishes a range (not a predicted one) and the standing salary answer is a stance rather than a figure, the answer becomes `Aligned with the posted range ($130,000-$165,000)`. A figure the user set always wins; with no posted range the standing value is used verbatim; with no standing answer at all the question stays `needs_user` and the range is offered as a one-click `suggestion`. `salaryMinAcceptable` never answers anything — a posted range starting below it produces a `compensation` advisory.

## Discovery sources
`source_budgets.enabled` is the runtime authority for **scheduled** discovery; a skill's `enabled:` frontmatter only seeds the flag the first time that source is seen, so a dashboard toggle is never reverted at the next boot. A manual `POST /api/search` with an explicit `sources` list always wins. Key-gated sources (adzuna, usajobs) stay excluded while their API key is missing, whatever the toggle says.
- `GET  /api/sources` → `SourceBudget[]` (each row carries `enabled`, `keyGated`, `blockedReason`)
- `PATCH /api/sources/:source` body `{ enabled: boolean }` → the updated `SourceBudget`; emits `queue.snapshot` + `connection.updated`
- `GET /api/queue`'s `budgets` carry the same enriched rows.

## Search & queue
- `POST /api/search` body `{ keywords, experience?, remote?: RemoteType, location?, sources?: string[] }` → `{ searchId }`; results stream as `job.discovered` SSE events  (FR-3)
- `GET  /api/queue` → `{ tasks: QueueTask[], budgets: SourceBudget[], paused: boolean, nextRuns: { discover, emailScan, followup } }` (`nextRuns` = next scheduled sweep times, ISO or null — drives the dashboard's idle state)
- Task claiming: `priority DESC, id ASC` — `QueueTask.priority` is 10 for user-initiated tasks (apply-pipeline clicks, from-url, ask, setup, feedback, manual discovery/search/scan, regenerate-queries, outbox approvals, prep regen, legit-override rescore), 5 for auto-advance tailors (incl. the backfill sweep), 0 for bulk/background work. The runner keeps up to `queueConcurrency` (settings, 1-4, default 2) agent-bound tasks in flight in parallel; `apply` (one headed browser) and `discover` (source politeness) are each serialized to one in flight but may run alongside the agent pool.
- Auto-advance backfill: at boot, on the periodic recovery sweep, and after `autoAdvance`/`autoAdvanceThreshold` changes, screened jobs that already clear the auto-advance gate (legit, no location veto, threshold met, no application/live tailor task) are queued for tailoring at priority 5, capped at 10 per sweep.
- `POST /api/queue/run-discovery` → `{ taskId }` — enqueue a discovery sweep immediately (budgets still respected); if a discover task is already pending/running, returns that task's id instead of enqueueing another
- `POST /api/queue/pause` / `POST /api/queue/resume` → queue snapshot
- `POST /api/queue/rate` body `{ discoveryIntervalMinutes }` → `Settings`
- `POST /api/queue/retry-failed` body `{ type?: TaskType }` → `{ requeued: number }` — bulk retry: every failed task (optionally filtered to one type) back to `pending` with `attempts` reset to 0; explicit user cancellations (`lastError: 'Cancelled by user'`) are left alone. Emits a fresh `queue.snapshot`.
- `POST /api/queue/tasks/:id/resolve-human` body `{ answers?: Record<string,string> }` → `QueueTask` (user did the manual step; worker resumes)  (FR-25). When the parked task is an `apply` and its payload carries `choices` (the field's REAL option list the driver refused to guess at), `answers` records the user's picks onto the application's screening answers before resuming.
- A parked `apply` task's payload also carries `parkReason: ParkReason` — `dead_posting | captcha | login_wall | unmatched_field | low_confidence | driver_manual` — an explicit discriminator rather than something inferred from the prompt text. The needs-attention card renders it as a badge (`PARK_REASON_LABELS`). `dead_posting` never actually parks: it expires the job and fails the task instead.
- Terminal failures: outcomes a retry cannot change (dead posting, not an application form) go straight to `failed` with no backoff (`TerminalFailure` → `TaskQueue.failNow`), so a gone posting stops consuming apply slots. `attempts` stays at its current value.
- `POST /api/queue/tasks/:id/retry` → `QueueTask`
- `POST /api/queue/tasks/:id/cancel` → `QueueTask & { aborted: boolean }` — cancels **pending AND running** tasks: the in-flight `AbortController` kills the spawned Claude CLI process tree, the slot frees, and the task becomes `failed` with `lastError: 'Cancelled by user'` (bulk retry always skips those). A cancelled `tailor` rolls its job back to `screened`.
- `POST /api/queue/cancel-all` body `{ scope: 'running' | 'pending' | 'all', type?: TaskType }` → `{ cancelled: number }`
- Enqueue dedupe: `TaskQueue.enqueueUnique(type, dedupeKey, options)` keeps at most ONE live task (pending/running/paused/needs_human/waiting_session) per `(type, dedupeKey)`, merging the key into the payload and returning `{ task, existing }`. Every `apply` enqueue path goes through it keyed on `applicationId` — the approve endpoint, the tailor's auto-submit, and any retry — so no path can queue the same submission twice. Terminal tasks never block a fresh enqueue, so retrying after a failure still works.
- Zombie recovery (server-side, no endpoint): on boot every `running` claim is requeued to `pending` (`attempts` preserved, `lastError: 'reclaimed after stale run'`), and a periodic sweep requeues `running` tasks whose `updatedAt` is older than 10 minutes. Jobs stuck in `tailoring` with no live tailor task revert to `screened` (toast + `job.scored` SSE).
- Duplicate-apply collapse (boot + periodic sweep): per application, the oldest live `apply` task keeps the work and every other **pending** one becomes `done` with `lastError: 'Superseded by an earlier identical task #N'`. Running tasks are never touched (a browser may be open), superseded tasks never appear in the failed count, and "Retry all failed" cannot resurrect them. Heals rows created before `enqueueUnique` existed.
- Query-shaped title cleanup (boot): a job whose title is a search query rather than a posting (`/^Full-?stack Engineer$/i`, `site:`/`intitle:` operators, `-Senior`-style negative keywords) is set to `skipped` with `[cleanup: the title is a search query, not a posting — skipped, never applied to]` appended to `legitReasons`. Nothing is deleted — the row is the evidence of how the query leaked into a portal search.
- The apply worker no-ops (audit `apply.skipped_already_submitted`, task `done`) when the application already has `submittedAt`, checked before the approval record so it is never a retrying failure.

## Emails & outbox
- `GET  /api/emails?direction&classification&limit&offset` → `{ total: number, emails: EmailRecord[] }` (default limit 50, max 500; newest first)  (FR-20)
- `PATCH /api/emails/:id` body `{ applicationId: number | null }` → `EmailRecord` — "this email is about that application". Sets `matchBasis: 'manual'`, clears `matchCandidates`, and applies the status effect the classification implies (so resolving an ambiguous rejection closes the right application, and an offer moves it to Offer). `null` unlinks. Inbound only; 409 on an outbound row, 404 on an unknown application.
- `GET  /api/outbox` → `EmailRecord[]` (drafts with `needsApproval:true`). Also holds **application emails** for `email`-channel postings: the apply worker drafts one per application (thread key `application-app-<id>`, body naming the tailored PDFs to attach) instead of driving a browser, and it sends only through the normal approve path. Approving the application never sends anything by itself.
- `POST /api/outbox/:id/approve` → `EmailRecord` (queued for send in next session)  (FR-11)
- `POST /api/outbox/:id/reject` body `{ reason? }` → `EmailRecord`
- `POST /api/emails/scan` → `{ taskId }` (manual trigger of the periodic scan)

### Classification & application matching
`EmailClass` is `reply_accepted | reply_rejected | interview_invite | offer | opportunity | followup | other`. **`offer` is distinct from `reply_accepted`**: a formal offer (compensation plus a start date or a response deadline) moves the job + application to `offer` and celebrates; a merely positive interim reply moves them to `interview`. A stated `offer.respondBy` becomes a `deadline` schedule event, and the employer's own figures (`offer.salary`, `startDate`, `respondBy`) are folded verbatim into the stored summary. `hired` and a declined offer are never auto-proposed — those stay user actions.

Matching an inbound email to an application is scored, not first-row-wins: **posting URL** (normalized: scheme, `www.`, query and trailing slash ignored) → **company** (normalized: case, punctuation and legal suffixes ignored) → **job-title similarity** → **live status preference** (`applied`/`interview`/`offer`/`ready_for_review` beat closed ones) → recency. `EmailRecord.matchBasis` (`'url' | 'company_title' | 'company' | 'manual' | null`) records which signal won, so the Inbox can say why. When the top two candidates are within the ambiguity margin the email is stored with `applicationId: null` and `matchCandidates: EmailMatchCandidate[]` — **no application is touched** — and the Inbox renders "Which application is this about?" with the candidates as one-click choices resolved by `PATCH /api/emails/:id`. `IntakeSummary` reports `offersRecorded` and `ambiguous` alongside the existing counts.

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
- `DELETE /api/feedback/:id` → `{ ok: true }`
- `DELETE /api/feedback?kind=<FeedbackKind>` → `{ deleted: number }` (omit `kind` to clear all). Deleting an entry whose plan change was already applied never reverts that settings change.
- `POST /api/feedback/:id/apply-plan` → `FeedbackEntry` (applies proposed plan change)
- `POST /api/ask` body `{ prompt }` → `{ requestId }`; stream via `ask.delta` SSE events  (FR-29). Conversational: the server stores the ask session id and resumes it on every ask. **The chat can edit profile and search-query files within a safe-list (`CLAUDE.md`, `documents/**.md|.txt`, `.claude/skills/job-application-assistant/*.md`, `.claude/skills/job-scraper/search-queries.md`) with no interactive approval** — the run carries path-scoped `Edit`/`Write` permission rules plus a system note that no approval prompt exists in a headless session, and any write outside the safe-list is reverted and reported. A turn that edited files appends the file list to the reply, toasts, and (for `search-queries.md`) suggests re-running discovery; the dashboard refetches `/api/profile` when the turn completes.
- `POST /api/ask/clear` → `{ ok: true }` — drops the stored ask session; the next ask starts a fresh conversation.
- `GET  /api/settings` / `PATCH /api/settings` body `Partial<Settings>` → `Settings` — includes the granular per-task model routing keys `modelAsk` (default `haiku`), `modelSetup` (`sonnet`), `modelScraper` (`haiku`), `modelScore` (`haiku`), `modelTailor` (`sonnet`), `modelPrep` (`sonnet`), `modelEmail` (`haiku`), `modelFollowup` (`sonnet`), `modelFeedback` (`sonnet`); values `default | haiku | sonnet | opus` (`default` = the user's own Claude Code model, possibly Opus — selectable but no task's default). The legacy `modelPipeline` key is migrated at boot: if its settings row exists, its value seeds the six new score/tailor/prep/email/followup/feedback keys once, then the row is deleted (fresh installs get the recommended defaults). Also `autoSubmitWhenResolved` (default true — layered on the submit gate: in `review`, an application whose screening answers ALL resolved, whose fit/legitimacy passed and whose ATS check passed submits without a review card; `hybrid` additionally needs the score threshold; anything unresolved still waits, and LinkedIn is always review-gated), `queueConcurrency` (1-4, default 2 — parallel agent-bound tasks in the runner) and the pipeline auto-advance keys `autoAdvance` (`off | threshold | all`, default `threshold`) and `autoAdvanceThreshold` (default 70): screened jobs that are legit, not location-vetoed, and meet the gate flow into tailoring automatically; submission still obeys the submit gate. Loosening the auto-advance gate triggers an immediate backfill sweep.
- `POST /api/reset` body `{ confirmation: 'RESET', scopes: ('db'|'artifacts'|'profile')[] }` → `{ preview?: string[], ok?: true }`; call with `{ preview: true }` first to get the deletion preview  (FR-28)

## Events
- `GET /api/events` → `text/event-stream` of `SseEvent` (`event:` field = `type`, `data:` = JSON). Heartbeat comment every 15 s. Client reconnect-safe (server sends `queue.snapshot` + full connection list on connect).

## Static
- `GET /files/*` → generated artifacts (PDFs, screenshots) from the archives dir. Read-only.
