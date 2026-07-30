---
name: usajobs-search
version: 1.0.0
description: >
  Use this skill to search US federal government jobs on USAJOBS — IT
  Specialist, software developer, and other 2210-series technology roles across
  federal agencies, with fully structured salary ranges and telework/remote
  designations. Requires a free API key (USAJOBS_API_KEY / USAJOBS_EMAIL env
  vars); disabled by default until a key is configured. Trigger phrases:
  usajobs, federal jobs, government jobs, federal IT jobs, government software
  developer, 2210 series, GS jobs, federal tech jobs, public sector software
  jobs, IRS/VA/DoD IT jobs.
context: fork
enabled: false  # optional key-gated source — set to true after exporting USAJOBS_API_KEY / USAJOBS_EMAIL
allowed-tools: Bash(bun run .agents/skills/usajobs-search/cli/src/cli.ts *)
---

# USAJOBS Search Skill (optional, free API key)

Search the **official USAJOBS Search API** — every US federal job posting, with
fully **structured remuneration** (salary ranges by GS grade), explicit
remote/telework designations, and application deadlines. Defaults to the
**2210 IT Management series** (the federal software/IT job family). Zero
runtime dependencies (runs with just `bun`).

## Setup (required before enabling)

1. Request a free key at <https://developer.usajobs.gov/apirequest/> (instant,
   email-verified).
2. Export `USAJOBS_API_KEY` (the key) and `USAJOBS_EMAIL` (the email you
   registered — the API requires it as the `User-Agent` header).
3. Flip `enabled: true` in this file's frontmatter so `/scrape` includes it.

Without credentials the CLI exits with a clear
`{ "code": "MISSING_API_KEY" }` error and setup instructions — it never makes
an unauthenticated request.

## Commands

### Search job listings

```bash
bun run .agents/skills/usajobs-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — keywords (title, skill, agency).
- `--location <text>` / `-l <text>` — place string (`"Dallas, Texas"`, `Texas`).
- `--remote` — only remote-designated positions (`RemoteIndicator=True`).
- `--category <code>` — `JobCategoryCode`, default `2210` (IT Management). Pass `none` to search all series.
- `--jobage <days>` — posted within N days (the API caps at 60).
- `--page <n>` / `--limit <n>` (`-n`) — API pagination (default 25/page).
- `--format json|table|plain` — default `json`.

### Fetch full job detail

```bash
bun run .agents/skills/usajobs-search/cli/src/cli.ts detail <control-number|url> [--format json|plain]
```

`control-number` is the search-result `id` (e.g. `834567800`); an announcement
number (`PositionID`) or a `https://www.usajobs.gov/job/<id>` URL also works.
The API has no fetch-by-id endpoint, so `detail` searches the id as a keyword
and matches exactly on the control number — one request. Returns job summary,
major duties, qualifications, salary, close date, and the direct apply link.

## Usage examples

```bash
# Federal software roles in Texas, last 30 days
bun run .agents/skills/usajobs-search/cli/src/cli.ts search -q "software developer" -l Texas --jobage 30 --format table

# Remote-designated federal IT roles
bun run .agents/skills/usajobs-search/cli/src/cli.ts search -q software --remote --limit 10 --format table

# Full announcement detail
bun run .agents/skills/usajobs-search/cli/src/cli.ts detail 834567800 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing IDs to `detail` |
| `table` | Quick scanning (includes the application CLOSES date) |
| `plain` | Reading a full announcement |

Search JSON is `{ "meta": { "count", "page", "total" }, "results": [...] }`;
results carry `salary_min`/`salary_max`/`salary_currency` (USD, annual),
`salary_interval`, `remote_type`, and `close_date`. All errors go to
**stderr** as `{ "error": "...", "code": "..." }` with exit code `1`.

## Notes

- `remote_type` mapping: `RemoteIndicator` → `remote`; telework-eligible (but
  office-anchored) positions → `hybrid`; otherwise null.
- Hourly-rated positions keep `salary_interval: "Per Hour"` with null salary
  numbers, so annual salary ranking is never polluted.
- Federal announcements close hard on `close_date` — surface it when deciding
  what to apply to. US citizenship is required for most federal positions;
  check the announcement's "Who may apply" section.
