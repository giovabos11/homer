---
name: hn-hiring-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search the monthly Hacker News
  "Ask HN: Who is hiring?" thread — startup and tech jobs posted directly by
  founders and hiring managers, many remote-friendly with posted salary ranges.
  Trigger phrases: hacker news jobs, HN who is hiring, whoishiring, ask hn
  hiring, hn hiring thread, startup jobs hacker news, who is hiring this month,
  YC startup jobs, jobs posted on hacker news, hn job thread.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/hn-hiring-search/cli/src/cli.ts *)
---

# HN "Who is hiring?" Search Skill

Search the monthly **Hacker News "Ask HN: Who is hiring?"** thread through the
public **Algolia HN API**. Each top-level comment is one job posting, written by
the hiring company itself — heavy on startups, often with concrete salary
ranges and explicit REMOTE/ONSITE flags. No authentication and zero runtime
dependencies (runs with just `bun`).

The CLI finds the latest thread automatically (via the `whoishiring` bot's
story history), fetches it once, and caches it for 6 hours — the thread tree is
large, so repeated searches within that window make zero requests.

## Commands

### Search job postings

```bash
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — keywords matched against the full posting text.
- `--location <text>` / `-l <text>` — matches the parsed location or the posting's header line.
- `--remote <mode>` — `remote`, `hybrid`, or `onsite` (parsed from the posting). Bare `--remote` means remote.
- `--thread <story-id>` — search a specific month's thread instead of the latest.
- `--jobage <days>` — posted within N days (new postings trickle in all month).
- `--page <n>` / `--limit <n>` (`-n`) — pagination over filtered postings (default 25/page).
- `--format json|table|plain` — default `json`.

### Fetch a full posting

```bash
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail <comment-id|url> [--format json|plain]
```

`comment-id` is the search-result id (e.g. `48747990`); a
`https://news.ycombinator.com/item?id=...` URL also works. Returns the complete
posting text plus the parsed fields.

## Usage examples

```bash
# Remote React roles in this month's thread
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q react --remote --format table

# Full-stack roles mentioning New York
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts search -q "full stack" -l "new york" --limit 10 --format table

# The full text of one posting
bun run .agents/skills/hn-hiring-search/cli/src/cli.ts detail 48747990 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — programmatic use, passing IDs to `detail` |
| `table` | Quick human-readable scanning (company/role/location/work columns) |
| `plain` | Reading postings in full (`detail` command) |

Search JSON is `{ "meta": { "count", "page", "total", "thread_id",
"thread_title", "cached" }, "results": [...] }`; search rows carry a `snippet`
instead of the full text (which `detail` returns). All errors go to **stderr**
as `{ "error": "...", "code": "..." }` with exit code `1`.

## Notes — parsed fields are best-effort

Postings follow a loose community convention (`Company | Role | Location |
Salary | REMOTE`), so `company`, `title`, `location`, `remote_type`, and the
salary fields are regex-parsed **best-effort** and null when a posting deviates.
The full text is always intact — treat parsed fields as filters/hints and read
`detail` before acting on a posting. Salary is recognized for explicit ranges
like `$150k-$200k` or `$150,000 - $200,000` (USD).
