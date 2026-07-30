---
name: remotive-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search remote jobs on Remotive —
  curated remote software development, data, DevOps, product, and design roles,
  filtered by where the candidate must be located (USA, Worldwide, etc.).
  Trigger phrases: remotive, remote jobs, remote software developer jobs,
  remote jobs USA, curated remote jobs, remote work board, remote dev
  positions, remote jobs worldwide, remote engineering roles, work from
  anywhere jobs.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/remotive-search/cli/src/cli.ts *)
---

# Remotive Search Skill

Search **Remotive**'s public remote-jobs API (`https://remotive.com/api/remote-jobs`).
Curated remote listings with a `candidate_required_location` field — ideal for
filtering to roles a US-based candidate is actually eligible for. No
authentication and zero runtime dependencies (runs with just `bun`).

## ⚠️ Hard politeness limit — do not weaken

Remotive's API guidelines allow polling only **a couple of times per day**. The
CLI enforces this: it fetches one category listing per request (never using
server-side search params), **caches it for 12 hours** in `cli/.cache.json`,
and answers every query/location filter client-side from the cache. That means
at most ~2 real fetches/day per category. Never bypass or shorten the cache,
and never loop distinct server-side queries against the API.

## Commands

### Search job listings

```bash
bun run .agents/skills/remotive-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — keywords matched against title/company/tags (client-side).
- `--location <text>` / `-l <text>` — `candidate_required_location` filter. `USA` (or `US`, `United States`) also matches `Worldwide` / `Anywhere` / `Americas`-style postings a US candidate fits.
- `--category <cat>` — Remotive category slug, default `software-dev` (others: `data`, `devops`, `product`, `design`, `marketing`, ...). Each category caches separately.
- `--jobage <days>` — posted within N days.
- `--page <n>` — 1-indexed page over the filtered listing.
- `--limit <n>` / `-n <n>` — page size (default 25).
- `--format json|table|plain` — default `json`.

### Fetch full job detail

```bash
bun run .agents/skills/remotive-search/cli/src/cli.ts detail <id|url> [--category <cat>] [--format json|plain]
```

`id` is the numeric id from search results (e.g. `2090903`); a full
`remotive.com/remote-jobs/...` URL also works. Served from the same cached
listing — pass the same `--category` the search used. Returns the full
description converted from HTML to readable text, plus
`salary_min`/`salary_max`/`salary_currency` (parsed) and `salary_raw` (the
original Remotive salary string), `remote_type` (always `remote`), tags, and
job type.

## Usage examples

```bash
# Remote React roles open to US candidates, last 2 weeks
bun run .agents/skills/remotive-search/cli/src/cli.ts search -q react -l USA --jobage 14 --format table

# Python roles in the data category
bun run .agents/skills/remotive-search/cli/src/cli.ts search --category data -q python --limit 10 --format table

# Full detail for one posting
bun run .agents/skills/remotive-search/cli/src/cli.ts detail 2090903 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing IDs to `detail` |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single job's full detail (`detail` command) |

Search JSON is `{ "meta": { "count", "page", "total", "category", "cached" },
"results": [...] }`. All errors go to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1`.

## Notes

- Salary is free text on Remotive. Annual-looking amounts ("$130,000 -
  $160,000/yr", "$140k-$180k") are parsed into numeric fields; hourly/daily
  rates deliberately stay `null` (kept in `salary_raw`) so they never pollute
  annual salary ranking.
- `remote_type` is always `"remote"` — the board is remote-only. The relevant
  eligibility filter is `--location` on `candidate_required_location`.
- Delete `cli/.cache.json` only when strictly necessary; the 12h TTL is the
  politeness contract with Remotive.
