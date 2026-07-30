---
name: weworkremotely-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search remote jobs on We Work
  Remotely (WWR) — remote programming, full-stack, front-end, back-end, and
  DevOps roles, including many "USA Only" and "North America Only" postings.
  Trigger phrases: we work remotely, weworkremotely, wwr jobs, remote
  programming jobs, remote developer jobs, remote full-stack jobs, remote
  front-end jobs, remote back-end jobs, remote devops jobs, USA-only remote
  jobs, largest remote work community, remote job board.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/weworkremotely-search/cli/src/cli.ts *)
---

# We Work Remotely Search Skill

Search **We Work Remotely**'s public RSS feeds — one of the largest remote-only
job boards, with per-category programming feeds and explicit hiring regions
("Anywhere in the World", "USA Only", "North America Only"). No authentication
and zero runtime dependencies (runs with just `bun`). Feeds are cached for 1
hour, so a search→detail workflow makes at most a couple of requests.

## Commands

### Search job listings

```bash
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — keywords matched against title, company, category, and full description.
- `--location <text>` / `-l <text>` — region substring (e.g. `usa`, `north america`, `anywhere`).
- `--category <cat>` — `programming` (default) | `full-stack` | `front-end` | `back-end` | `devops` | `all`.
- `--jobage <days>` — posted within N days.
- `--page <n>` — 1-indexed page over the filtered feed.
- `--limit <n>` / `-n <n>` — page size (default 25).
- `--format json|table|plain` — default `json`.

### Fetch full job detail

```bash
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts detail <slug|url> [--format json|plain]
```

`slug` is the search-result `id` (e.g. `tether-ai-research-engineer`); a full
`https://weworkremotely.com/remote-jobs/<slug>` URL also works. The RSS
`description` carries the entire job listing, so `detail` returns the full text
without fetching the job page. If the slug is not in the requested category
feed, the all-jobs feed is tried automatically.

## Usage examples

```bash
# Recent remote React roles
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts search -q react --jobage 14 --format table

# USA-eligible full-stack roles
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts search --category full-stack -l usa --limit 10 --format table

# Full detail for one listing
bun run .agents/skills/weworkremotely-search/cli/src/cli.ts detail tether-ai-research-engineer --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing slugs to `detail` |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single job's full detail (`detail` command) |

Search JSON is `{ "meta": { "count", "page", "total", "category", "cached" },
"results": [...] }`. All errors go to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1`.

## Notes

- All jobs are remote (`remote_type: "remote"`); the eligibility signal is the
  region in `location` — filter with `-l usa` / `-l "north america"`.
- Salary fields are filled only when the posting text carries an explicit
  dollar range (WWR has no structured salary field); otherwise they are null.
- Feeds carry only recent postings (~25 per category feed); this is a freshness
  source, not an archive.
