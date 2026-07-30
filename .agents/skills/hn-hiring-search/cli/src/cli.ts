#!/usr/bin/env bun
// Self-contained CLI for the monthly Hacker News "Ask HN: Who is hiring?"
// thread, via the public Algolia HN API. Zero runtime dependencies — runs
// anywhere `bun` is available. The thread item tree is cached for 6 hours.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", l: "location", n: "limit" }

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-")) {
      ;(flags._ as string[]).push(a)
      continue
    }
    const key = ALIAS[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("-")) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

const HELP = `hn-hiring-cli — search the monthly HN "Ask HN: Who is hiring?" thread

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <comment-id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords matched against the full posting text.
  --location, -l <text>   Location filter (parsed location or header line).
  --remote <mode>         remote | hybrid | onsite. Bare --remote means remote.
  --thread <story-id>     Search a specific month's thread instead of the latest.
  --jobage <days>         Posted within N days (postings trickle in all month).
  --page <n>              1-indexed page over the filtered postings. Default 1.
  --limit, -n <n>         Page size. Default 25.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <comment-id|url>        A comment id from search results, or a
                          https://news.ycombinator.com/item?id=... URL.
                          Returns the full posting text.

EXAMPLES
  bun run src/cli.ts search -q "react" --remote --format table
  bun run src/cli.ts search -q "full stack" -l "new york" --limit 10 --format table
  bun run src/cli.ts detail 48747990 --format plain

Postings follow the loose "Company | Role | Location | Salary | REMOTE" header
convention; parsed fields are best-effort — detail always has the full text.
`

function parseIntFlag(name: string, raw: string | boolean | string[]): number | null {
  const val = parseInt(raw as string, 10)
  if (isNaN(val)) {
    process.stderr.write(
      JSON.stringify({ error: `--${name} must be a number, got "${raw}"`, code: "BAD_ARG" }) + "\n",
    )
    return null
  }
  return val
}

function stringFlag(raw: string | boolean | string[] | undefined, whenBare?: string): string | undefined {
  if (typeof raw === "string") return raw
  if (raw === true) return whenBare
  return undefined
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  if (cmd === "search") {
    const fmt = (flags.format as string) || "json"

    for (const name of ["jobage", "page", "limit"] as const) {
      if (flags[name] !== undefined) {
        const v = parseIntFlag(name, flags[name])
        if (v === null) return 1
        flags[name] = String(v)
      }
    }

    const remote = stringFlag(flags.remote, "remote")
    if (remote !== undefined && !["remote", "hybrid", "onsite"].includes(remote)) {
      process.stderr.write(
        JSON.stringify({ error: `--remote must be remote|hybrid|onsite, got "${remote}"`, code: "BAD_ARG" }) + "\n",
      )
      return 1
    }

    const thread = stringFlag(flags.thread)
    if (thread !== undefined && !/^\d+$/.test(thread)) {
      process.stderr.write(
        JSON.stringify({ error: `--thread must be a numeric HN story id, got "${thread}"`, code: "BAD_ARG" }) + "\n",
      )
      return 1
    }

    const opts: SearchOpts = {
      query: stringFlag(flags.query),
      location: stringFlag(flags.location),
      remote,
      thread,
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : 9999,
      page: flags.page ? Math.max(1, parseInt(flags.page as string, 10)) : 1,
      limit: flags.limit ? Math.max(1, parseInt(flags.limit as string, 10)) : 25,
      format: (["json", "table", "plain"].includes(fmt) ? fmt : "json") as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) {
      process.stderr.write(JSON.stringify({ error: "detail requires a <comment-id|url>", code: "NO_ID" }) + "\n")
      return 1
    }
    const fmt = (flags.format as string) || "json"
    const opts: DetailOpts = { id, format: fmt === "plain" ? "plain" : "json" }
    return runDetail(opts)
  }

  process.stderr.write(JSON.stringify({ error: `Unknown command "${cmd}"`, code: "BAD_CMD" }) + "\n")
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }) + "\n",
    )
    process.exit(1)
  })
