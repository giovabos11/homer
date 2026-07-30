# apps/server — local service layer

Express 5 + TypeScript + Drizzle/better-sqlite3 (WAL) orchestrator for the
ai-job-search platform (PRD §6). It schedules work through a SQLite task queue,
runs Claude Code headlessly on your subscription (no API key), runs portal
skill CLIs for job discovery, and exposes the REST + SSE API consumed by
`apps/dashboard` (contract: `apps/CONTRACT.md`).

Binds to **127.0.0.1:4750 only** — nothing is exposed off-machine (PRD §8).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Type-check + compile to `dist/` |
| `npm start` | Run the compiled server (`node dist/server/src/index.js`) |
| `npm test` | Vitest suite (queue, budgets, dedupe, gate, reset, API smoke) |
| `npm run db:migrate` | Apply pending SQL migrations to `data/app.db` |
| `npm run db:seed` | Seed demo jobs/applications/emails/schedule for dashboard dev |

Environment variables:

- `SIMULATE=1` — stub workers produce realistic fake outcomes (scores, placeholder
  PDFs, state transitions with delays) so the dashboard can be demoed end-to-end
  without Claude, Bun, or a browser. The apply stub **never** claims a real
  submission outside SIMULATE; it parks as `needs_human` instead.
- `PORT` — override the port (default 4750).
- `DB_PATH` — override the DB file for `db:migrate`.

Runtime files live under `apps/server/data/` (gitignored): `app.db` (SQLite,
WAL), `artifacts/` (PDFs, screenshots, prep guides — served read-only at
`/files/*`), `audit.log` (credential reveal log), `vault.enc` (only when the
encrypted-file vault fallback is active).

## Settings

Defaults come from `config/default.json → settings` and are seeded into the
`settings` table on first boot (existing values always win; edit at runtime via
`PATCH /api/settings` or the dashboard). Every key:

| Setting | Default | Meaning |
| --- | --- | --- |
| `gateMode` | `review` | Submission gate (PRD D1): `review` = every application waits for your click in "Ready for review". `auto` = submit as soon as checks pass (fully audit-logged). `hybrid` = auto-submit only when fit score ≥ `hybridThreshold`, review otherwise. |
| `hybridThreshold` | `75` | Fit score (0–100) at or above which `hybrid` mode auto-submits. |
| `discoveryIntervalMinutes` | `360` | How often the scheduler enqueues a discovery run (15–1440). Also settable via `POST /api/queue/rate` (dashboard rate slider). |
| `emailScanIntervalMinutes` | `120` | How often an `email_scan` task is enqueued. Runs only while a Claude session is active (D4); otherwise the task waits as `waiting_session`. |
| `country` | `US` | Active job market (ISO-2). Drives which portal-skill set the dashboard offers (FR-24). |
| `applyDriver` | `playwright` | Browser driver for form fill: `playwright` (headed Chromium, persistent profile) or `chrome` (Claude in Chrome — your real browser, for automation-hostile sites). |
| `perSourceGates` | `{ "linkedin": "review" }` | Per-source gate overrides; they beat `gateMode`. LinkedIn ships locked to `review` (ToS risk — keep it). |
| `followupAfterDays` | `10` | Days of employer silence before a follow-up draft is created (draft always waits in the Outbox for your approval). |
| `maxFollowups` | `2` | Maximum follow-ups per application. |

Other tunables in `config/default.json` (not runtime-editable): queue retry
policy (`queue.maxAttempts` 5, exponential backoff from `backoffBaseMs` 30 s
capped at `backoffMaxMs` 1 h), `queue.followupSweepCron` (daily 09:00),
discovery paging (`discovery.maxPagesPerSource`, `discovery.pageSize`,
`discovery.defaultQuery`), and per-source token budgets (`budgets.default` =
60 tokens refilling 30/h; `budgets.perSource` pins Remotive to ~2/day and
LinkedIn to a strict trickle).

## From scratch (new user checklist)

1. **Install prerequisites:** Node 22+, npm. Optional but recommended: Bun
   (runs the portal skill CLIs — without it, discovery reports sources as
   down), Claude Code CLI signed in with your subscription (powers ask,
   scoring, tailoring; without it a MockRunner answers), and the Playwright
   Chromium browser (`npx playwright install chromium` in this directory —
   used by the PDF rendering and apply phases).
   Windows note: stopping `npm run dev` can orphan the child node process
   holding port 4750; if a restart says the port is busy, end the stale
   `node` process in Task Manager first.
2. `cd apps/server && npm install && npm run db:migrate`
3. Start it: `npm run dev` (or `SIMULATE=1 npm run dev` for a demo with fake
   data, plus `npm run db:seed` if you want a pre-filled dashboard).
4. Check `GET http://127.0.0.1:4750/api/health` and the dashboard Connections
   panel — each card tells you what is missing and how to fix it.
5. Personalize: run `/setup` in Claude Code (fills `CLAUDE.md` + profile skill
   files from your `documents/`), then `PATCH /api/settings` (or the dashboard
   Settings view) for gate mode, discovery rate, and country. No
   Giovanni-specific values are hardcoded in the server — identity is read
   from your populated profile files at request time (PRD §9).
6. Optional keys: paste free Adzuna / USAJobs API keys in the Connections
   panel (`POST /api/connections/:name/key`) — stored in the OS vault, never
   in files or the DB.

## Layout

- `src/db` — Drizzle schema, WAL SQLite client, plain-SQL migration runner (`migrations/*.sql`)
- `src/queue` — task queue (atomic claim, cursors, retry/backoff, pause), token-bucket budgets, croner scheduler, runner loop
- `src/agent` — `AgentRunner` seam: Claude Code headless runner + MockRunner (see `src/agent/README.md` for the LiteLLM/`ANTHROPIC_BASE_URL` provider swap)
- `src/sources` — portal-skill discovery (SKILL.md frontmatter), Bun CLI adapter, dedupe/upsert
- `src/workers` — worker registry: discovery + followup sweep are real; score/tailor/apply/email/prep/profile-sync/feedback are stubs with SIMULATE mode (each stub's header documents the real implementation to come)
- `src/api` — every route in `apps/CONTRACT.md` (zod-validated), SSE bus at `/api/events`, `/files/*` static artifacts
- `src/vault` — Windows Credential Manager (`@napi-rs/keyring`) with AES-256-GCM encrypted-file fallback
- `src/connections` — integration status probe/cache for the Connections panel

## Vault backends

Preferred: **Windows Credential Manager** via `@napi-rs/keyring` (service
`ai-job-search`). If the native module cannot load, the server falls back to an
AES-256-GCM encrypted file (`data/vault.enc`) keyed by a random machine-local
secret at `%APPDATA%\ai-job-search\vault.key`. The active backend is printed at
boot. SQLite only ever stores vault references; reveals are logged to
`data/audit.log`.
