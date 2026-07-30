---
name: ats-boards-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search current job openings at US
  tech companies directly from company career pages — software engineering,
  full-stack, frontend, backend, mobile, data, and adjacent roles. It sweeps the
  official public job-board APIs of Greenhouse, Lever, and Ashby for ~175
  well-known companies (Stripe, Airbnb, OpenAI, Figma, Databricks, Anthropic,
  Palantir, Ramp, Vercel, Notion, and more), with structured salary ranges and
  real remote/hybrid/onsite flags. Trigger phrases: find tech jobs, software
  engineer openings, jobs at startups, company career pages, greenhouse jobs,
  lever jobs, ashby jobs, who is hiring engineers, US tech jobs, remote software
  jobs, new grad software engineer, "is <company> hiring", openings at
  <company>, direct ATS listings.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/ats-boards-search/cli/src/cli.ts *)
---

# ATS Boards Search Skill

Sweeps the **official public JSON job-board APIs** of three major applicant
tracking systems — **Greenhouse**, **Lever**, and **Ashby** — across a curated
registry of ~175 well-known US tech companies. These APIs are published by the
ATS vendors precisely so job boards can be embedded and read programmatically:
no authentication, no HTML scraping, no ToS risk, and zero runtime dependencies
(runs with just `bun`).

This is the backbone US job source: full descriptions, structured salary ranges
(Greenhouse pay ranges, Lever `salaryRange`, Ashby compensation), and real
remote/hybrid/onsite workplace flags.

## The company registry

`companies.json` (skill root) lists the swept companies:

```json
[{ "slug": "stripe", "ats": "greenhouse", "name": "Stripe" }]
```

- All shipped entries were **live-verified** against their ATS API at build time.
- Add your own targets by appending entries; set `"unverified": true` on entries
  you have not checked — a 404 board is reported per-company in `meta.errors`
  without failing the sweep.
- `ats` must be `greenhouse`, `lever`, or `ashby`.

## Commands

### Search job listings

```bash
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — title keywords; every word must match (e.g. `-q "software engineer"`). Recommended.
- `--location <text>` / `-l <text>` — location substring filter (e.g. `Dallas`, `New York`).
- `--remote <mode>` — `remote`, `hybrid`, or `onsite`. Bare `--remote` means remote.
- `--ats <kind>` — sweep only `greenhouse`, `lever`, or `ashby`.
- `--companies <slugs>` — comma-separated slugs to sweep (e.g. `stripe,figma,linear`).
- `--jobage <days>` — posted within N days (jobs with no readable date pass through).
- `--page <n>` — 1-indexed **company batch**. The sweep pages by company, not by job: page 1 sweeps the first `--batch` companies, page 2 the next, etc. `meta.batches` reports the page count.
- `--batch <n>` — companies per page (default 40).
- `--limit <n>` / `-n <n>` — cap results emitted (client-side).
- `--format json|table|plain` — default `json`.

> **Pace note**: the sweep is sequential with a hard global cap of ~2 requests/s,
> so one default page (40 companies) takes ~20–30 s. Narrow with `--companies`
> or `--ats` when you don't need the full registry.

### Fetch full job detail

```bash
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

`id` is the search-result id in `<ats>:<company-slug>:<job-id>` form (e.g.
`greenhouse:stripe:7954688`). A `boards.greenhouse.io`, `job-boards.greenhouse.io`,
`jobs.lever.co`, or `jobs.ashbyhq.com` job URL also works. Returns the full
description plus `salary_min`/`salary_max`/`salary_currency`, `remote_type`,
and `employment_type` (null when the posting doesn't publish them).

## Usage examples

```bash
# Remote software-engineer roles across the whole registry, first batch
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q "software engineer" --remote --limit 20 --format table

# React roles in Dallas or New York offices, second company batch
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search -q react -l "Dallas" --page 2 --format table

# Just three target companies, fresh postings only
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search --companies stripe,figma,linear -q engineer --jobage 14 --format json

# Only the Ashby boards (OpenAI, Notion, Ramp, Linear, ...)
bun run .agents/skills/ats-boards-search/cli/src/cli.ts search --ats ashby -q engineer --format table

# Full detail (description + salary) for one job
bun run .agents/skills/ats-boards-search/cli/src/cli.ts detail greenhouse:stripe:7954688 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing IDs to `detail` |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single job's full detail (`detail` command) |

Search JSON is `{ "meta": { "count", "page", "batches", "batch_size",
"companies_total", "companies_swept", "errors?" }, "results": [...] }`; each
result carries `id`, `title`, `company`, `location`, `date`, `url`,
`remote_type`, `salary_min`, `salary_max`, `salary_currency` (null when
missing). All errors are written to **stderr** as
`{ "error": "...", "code": "..." }` and the process exits with code `1`.

## Notes

- Official ATS APIs — no credentials, no scraping. 429/5xx are retried with
  exponential backoff; a 404 board is a per-company `meta.errors` entry.
- Salary coverage varies: Greenhouse publishes pay ranges only on the detail
  endpoint (and only where required/configured); Lever and Ashby often carry
  ranges directly in search results.
- Ashby has no per-job endpoint, so `detail` on an `ashby:` id re-fetches that
  company's board and picks the job out.
- Sorting is newest-first; undated jobs sort last.
