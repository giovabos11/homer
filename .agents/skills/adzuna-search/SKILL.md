---
name: adzuna-search
version: 1.0.0
description: >
  Use this skill to search US job listings on Adzuna — a broad aggregator with
  salary annotations on most listings, including Adzuna's predicted-salary
  estimates. Requires a free API key (ADZUNA_APP_ID / ADZUNA_APP_KEY env vars);
  disabled by default until a key is configured. Trigger phrases: adzuna,
  adzuna jobs, salary-annotated job search, jobs with salary data, aggregate
  job search US, adzuna api, search adzuna for jobs.
context: fork
enabled: false  # optional key-gated source — set to true after exporting ADZUNA_APP_ID / ADZUNA_APP_KEY
allowed-tools: Bash(bun run .agents/skills/adzuna-search/cli/src/cli.ts *)
---

# Adzuna Search Skill (optional, free API key)

Search the **Adzuna Jobs API** (US endpoint) — a large job aggregator whose
standout feature is **salary data on most listings**, including a
`salary_is_predicted` flag for Adzuna's ML-estimated salaries. Zero runtime
dependencies (runs with just `bun`).

## Setup (required before enabling)

1. Register free at <https://developer.adzuna.com> → get an **App ID** and
   **App Key**.
2. Export them: `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` (environment variables —
   never write them into files).
3. Flip `enabled: true` in this file's frontmatter so `/scrape` includes it.

Without credentials the CLI exits with a clear
`{ "code": "MISSING_API_KEY" }` error and setup instructions — it never makes
an unauthenticated request.

## Commands

### Search job listings

```bash
bun run .agents/skills/adzuna-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — keywords (title, skill, role).
- `--location <text>` / `-l <text>` — place string (`"Dallas, TX"`, `Texas`, `"New York"`).
- `--remote` — convenience flag that appends `remote` to the query (Adzuna US has no structured workplace filter).
- `--jobage <days>` — posted within N days (`max_days_old`).
- `--page <n>` — 1-indexed API page.
- `--limit <n>` / `-n <n>` — results per page (max 50, default 25).
- `--format json|table|plain` — default `json`.

### Fetch full job detail

```bash
bun run .agents/skills/adzuna-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Adzuna's API has **no fetch-by-id endpoint**, so `search` transparently caches
every result (`cli/.cache.json`, 7 days, capped at 500 entries) and `detail`
answers from that cache — run a search that returns the job first, then
`detail <id>` works offline and without a key. A never-cached id yields a
`NOT_CACHED` error explaining exactly that.

## Usage examples

```bash
# Salary-annotated software roles in Dallas
bun run .agents/skills/adzuna-search/cli/src/cli.ts search -q "software engineer" -l "Dallas, TX" --jobage 14 --format table

# Remote React roles
bun run .agents/skills/adzuna-search/cli/src/cli.ts search -q "react developer" --remote --limit 10 --format table

# Detail for a previously-searched job
bun run .agents/skills/adzuna-search/cli/src/cli.ts detail 5219438123 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing IDs to `detail` |
| `table` | Quick scanning (SAL column marks predicted salaries with `*`) |
| `plain` | Reading a single job's detail |

Search JSON is `{ "meta": { "count", "page", "total" }, "results": [...] }`;
results carry `salary_min`/`salary_max` (USD), `salary_is_predicted`, and a
sniffed `remote_type`. All errors go to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1`.

## Notes

- `salary_is_predicted: true` means the number is Adzuna's estimate, not the
  employer's posting — weigh it accordingly in salary ranking.
- `url` is an Adzuna redirect to the original posting.
- Descriptions in search responses are truncated by Adzuna; treat `detail` as
  a summary and follow `url` for the full posting when drafting applications.
- Free-tier rate limits are generous (thousands/month) but the CLI still backs
  off on 429/5xx.
