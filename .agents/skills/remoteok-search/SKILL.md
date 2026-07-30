---
name: remoteok-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search remote jobs on RemoteOK —
  remote software, engineering, design, marketing, and other tech-adjacent
  roles, worldwide or US-scoped, often with posted salary ranges. Trigger
  phrases: remote jobs, remote ok, remoteok, work from home jobs, remote
  developer jobs, remote react jobs, remote engineer positions, fully remote,
  digital nomad jobs, remote software engineer openings, remote jobs with
  salary, find remote work.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/remoteok-search/cli/src/cli.ts *)
---

# RemoteOK Search Skill

Search the **RemoteOK** public JSON feed (`https://remoteok.com/api`) — roughly
the 100 most recent remote job posts, many with USD salary ranges. No
authentication and zero runtime dependencies (runs with just `bun`).

**Feed etiquette** (RemoteOK's API terms): link back to the remoteok.com job URL
and keep request volume low. The CLI honors both — every result's `url` is the
canonical RemoteOK link, and the feed is **cached for 6 hours** in
`cli/.cache.json`, so repeated searches within that window make zero requests.

## Commands

### Search job listings

```bash
bun run .agents/skills/remoteok-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — keywords matched against title, company, tags, and description (every word must match).
- `--tags <list>` — comma-separated RemoteOK tags that must all be present (e.g. `dev,react`).
- `--location <text>` / `-l <text>` — location substring (posts carry regions like "Worldwide", "United States", "North America").
- `--jobage <days>` — posted within N days.
- `--page <n>` — 1-indexed page over the filtered feed.
- `--limit <n>` / `-n <n>` — page size (default 25).
- `--format json|table|plain` — default `json`.

### Fetch full job detail

```bash
bun run .agents/skills/remoteok-search/cli/src/cli.ts detail <id|slug|url> [--format json|plain]
```

`id` is the numeric id from search results (e.g. `1135528`); a RemoteOK slug or
a full `https://remoteok.com/remote-jobs/<slug>` URL also works. Returns the
full text description plus `salary_min`/`salary_max`/`salary_currency` (USD,
null when the post has no salary), `remote_type` (always `remote`), tags, and
the apply link. Detail is served from the same cached feed — no extra request.

## Usage examples

```bash
# Recent remote React roles
bun run .agents/skills/remoteok-search/cli/src/cli.ts search -q react --jobage 14 --format table

# Full-stack dev roles by tag
bun run .agents/skills/remoteok-search/cli/src/cli.ts search --tags dev,full-stack --limit 10 --format table

# US-scoped remote roles
bun run .agents/skills/remoteok-search/cli/src/cli.ts search -q engineer -l "United States" --format json

# Full detail for one post
bun run .agents/skills/remoteok-search/cli/src/cli.ts detail 1135528 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing IDs to `detail` |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single job's full detail (`detail` command) |

Search JSON is `{ "meta": { "count", "page", "total", "cached" }, "results": [...] }`.
All errors go to **stderr** as `{ "error": "...", "code": "..." }` with exit code `1`.

## Notes

- The feed only carries the ~100 most recent posts — `detail` on an older id
  reports `NOT_FOUND`. Treat this portal as a freshness source, not an archive.
- `salary_min`/`salary_max` of 0 in the feed mean "not posted" and are emitted
  as `null`.
- All jobs are remote by definition (`remote_type: "remote"`); use
  `--location` to narrow to US-eligible regions.
- Delete `cli/.cache.json` to force a fresh fetch before the 6h TTL expires.
