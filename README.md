# Homer

*Your local job application copilot for the US market.*

A **local-first AI job application platform** for the US software job market. It automatically discovers matching jobs, scores each one for fit *and* legitimacy (scam filtering), tailors a 1-page resume and 1-page cover letter as PDFs, fills out application forms behind a review gate, tracks your emails and interviews, and shows the whole pipeline on a gamified dashboard. Everything runs on your own machine on top of [Claude Code](https://claude.com/claude-code) using your existing Claude subscription — **no API key, no SaaS, no data leaves your computer**.

This is a fork of [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) (MIT licensed, 28k★) — huge credit to the upstream project, whose agentic engine (profile system, drafter–reviewer pipeline, fit evaluation, interview prep) powers everything here. The original framework README is preserved at [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md), and its detailed setup guide at [SETUP.md](SETUP.md). This fork adds US job sources, a local server that automates the workflow, and a web dashboard.

## Architecture in one paragraph

Three independently replaceable layers talk over clean seams. The **agent engine** is Claude Code itself: commands and profile skills in `.claude/`, portal-search CLIs in `.agents/skills/`, your career documents in `documents/`. The **service layer** (`apps/server`, Express + TypeScript + SQLite) schedules discovery/scoring/tailoring/apply/email work through a persistent task queue, runs Claude Code headlessly on your subscription, drives a real browser for form filling, and exposes a REST + SSE API on `127.0.0.1:4750` (localhost only). The **dashboard** (`apps/dashboard`, Vite + React) is a single-page mission control on port `5173` that consumes that API. The full picture, including mermaid diagrams of the pipeline and the apply-flow gates, is in [PRD.md](PRD.md) §6; the exact API surface is in [apps/CONTRACT.md](apps/CONTRACT.md).

## Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| **Node.js 22+** | Runs the server and dashboard | [nodejs.org](https://nodejs.org/) |
| **Bun** | Runs the portal-search CLIs (job discovery) | [bun.sh](https://bun.sh) — Windows: `powershell -ExecutionPolicy Bypass -c "irm https://bun.sh/install.ps1 | iex"` or `winget install Oven-sh.Bun` |
| **Claude Code CLI** | The AI engine — uses your Claude subscription, **no API key needed** | `npm install -g @anthropic-ai/claude-code`, then sign in once (run `claude` and complete the login flow, or type `/login` inside it) |
| **Git** | Cloning, and the profile reset feature uses it | [git-scm.com](https://git-scm.com/) |

**Windows notes:** the Bun installer puts `bun.exe` in `%USERPROFILE%\.bun\bin`. Open a *new* terminal after installing so it lands on your PATH (`bun --version` should work). The server also checks that folder directly as a fallback. Do **not** set `ANTHROPIC_API_KEY` — the platform deliberately uses your subscription login, and a stray API key would switch you to pay-per-token billing.

The US portal CLIs have zero runtime dependencies, so installing Bun itself is enough — no per-skill `bun install` needed.

## Quickstart

**Easiest (Windows):** double-click **`Start-Homer.cmd`** in the repo root (or the **Homer** shortcut on your Desktop). On first run it installs everything (a few minutes), prepares the database, starts the server and dashboard in two console windows, and opens the dashboard in your browser. Close those two windows to shut everything down. Every later run boots in seconds.

Prefer to do it by hand? Clone it (or clone your own fork):

```powershell
git clone https://github.com/giovabos11/homer.git
cd homer
```

**Terminal 1 — the server:**

```powershell
cd apps\server
npm install
npx playwright install chromium   # browser for PDF rendering + form filling
npm run db:migrate                # create the SQLite database
npm run db:seed                   # OPTIONAL: demo jobs/applications so the dashboard isn't empty
npm run dev
```

Verify it's up: open <http://127.0.0.1:4750/api/health> — you should see `{"ok":true, ...}`.

**Terminal 2 — the dashboard:**

```powershell
cd apps\dashboard
npm install
npm run dev
```

Open <http://localhost:5173>. The Connections panel on the dashboard tells you exactly what is healthy, what is missing, and how to fix it.

### Just want a demo first?

- **Dashboard only, no backend at all:** `npm run dev:mock` in `apps/dashboard` — runs against an in-browser mock API with sample data.
- **Full fake pipeline:** start the server with `SIMULATE=1` (PowerShell: `$env:SIMULATE='1'; npm run dev` — bash: `SIMULATE=1 npm run dev`). Stub workers produce realistic scores, placeholder PDFs, and state transitions with delays, so you can watch the whole flow end-to-end without Claude, Bun, or a browser installed. Simulate mode never actually submits anything anywhere.

## Using it with YOUR own data

This works for any user, from scratch — nothing about the repo owner is hardcoded in the server:

1. **Drop your documents in.** Put your resume/CV (PDF or LaTeX) in `documents/cv/`, your LinkedIn profile export PDF in `documents/linkedin/`, and optionally diplomas, reference letters, and past applications in their folders. `documents/README.md` explains the layout.
2. **Run `/setup`.** Open Claude Code at the repo root (`claude`) and run `/setup`. It reads your documents (or interviews you if you have none) and populates the profile: `CLAUDE.md` plus the skill files in `.claude/skills/job-application-assistant/` (candidate profile, behavioral profile, CV templates, interview STAR examples, search queries). This profile is what every evaluation, resume, and cover letter is grounded in.
3. **Stay current automatically.** The server watches `documents/` — when you add or edit a file, it queues a profile re-sync so the profile files keep up with your reality.

Note: this fork ships with profile files that the repo owner personalizes locally. If you are not them, run `/setup` with your own documents (and/or the dashboard's Reset with the `profile` scope, which restores the placeholder files) to make it yours.

## Connections and optional keys

Everything works with zero keys. Two optional free ones unlock extra salary-annotated coverage:

- **Adzuna** and **USAJobs**: register for a free API key, paste it into the dashboard **Connections** panel. Keys are stored in the OS credential vault (Windows Credential Manager), never in files or the database.
- **Gmail** is *session-only* by design — the server can't reach your inbox on its own. Email scan/send tasks queue up as "waiting for session"; when you're ready, open an interactive Claude Code session (with the claude.ai Gmail connector enabled) and run **`/email-bridge`**. It scans your inbox for interview invites, rejections, and recruiter outreach, sends any outbox drafts *you already approved on the dashboard*, and reports back to the server.
- **Browser profile for applying**: form filling uses a headed Chromium window with a persistent profile (`apps/server/data/browser-profile`). Log in to a job site there once and it stays logged in for future applications.
- **Captchas are never automated.** When one appears, the task parks as "needs human", the dashboard alerts you, and the browser window stays open — solve it yourself and click resume.

## Safety defaults

- **Nothing submits without you.** The submit gate starts in `review` mode: every application waits in the "Ready for review" column until you click approve. You can switch to `auto` or `hybrid` (auto only above a fit-score threshold) in Settings — until you do, no application is ever sent.
- **LinkedIn is always review-gated**, regardless of your global setting (ToS risk — keep it that way).
- **No fabricated claims.** Resumes and cover letters only use facts from your profile, verified against the PDF's actual text layer (what an ATS parser sees). Screening unknowns like salary expectations are flagged to you, never invented.
- **Local only.** The server binds to `127.0.0.1`, sends no telemetry, and keeps secrets out of files and the database.

## Deploying later (optional)

Built local-first, but the seams are ready:

- **Server** — a standard Node/Express app: `npm run build && npm start`, container-friendly. SQLite → Postgres is a Drizzle driver + migration change.
- **Dashboard** — `npm run build` produces a static bundle for any static host; the API base URL is the only wiring.
- **AI engine** — swap providers without touching the pipeline: point `ANTHROPIC_BASE_URL` at a LiteLLM gateway, or implement a second `AgentRunner`. See [apps/server/src/agent/README.md](apps/server/src/agent/README.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Server won't start: port 4750 in use | Free the port (something else grabbed it), or set `PORT` to another value — but note the dashboard dev proxy targets 4750 in `apps/dashboard/vite.config.ts`, so update that too if you change it. |
| Connections panel: "bun executable not found" | Install Bun, then restart the terminal (and server) so PATH updates. The server checks PATH first, then `%USERPROFILE%\.bun\bin\bun.exe`. |
| AI answers look canned / scoring is generic | Claude Code isn't installed or isn't logged in, so the built-in MockRunner is answering. Run `claude`, sign in with your subscription, restart the server. |
| PDF render or apply fails with a browser error | Playwright's Chromium isn't installed: `npx playwright install chromium` inside `apps/server`. |
| Tasks failing during heavy use (Claude usage limit) | Expected with subscription rate limits. Failed agent tasks retry automatically with exponential backoff (30 s up to 1 h, 5 attempts) — the queue picks them back up when your limit window resets. |
| Gmail card shows "waiting for session" | Not an error — that's the design. Run `/email-bridge` in an interactive Claude Code session to process the queued email tasks. |

## Danger zone: Reset

The dashboard Settings page has a Reset section mirroring the upstream `/reset` semantics. You choose scopes — `db` (wipe all job/application/queue data; settings survive), `artifacts` (delete generated PDFs and screenshots), `profile` (restore `CLAUDE.md` and the profile skill files to their placeholder state from git; your `documents/` folder is *not* touched) — then you get a preview of exactly what will be deleted, and nothing happens until you type `RESET` to confirm.

## License

MIT, same as upstream. See [LICENSE](LICENSE).
