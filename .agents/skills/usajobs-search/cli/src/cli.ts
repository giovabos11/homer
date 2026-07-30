#!/usr/bin/env bun
// Self-contained CLI for the official USAJOBS Search API (federal jobs).
// Zero runtime dependencies. Requires a FREE key in the environment:
//   USAJOBS_API_KEY  — from https://developer.usajobs.gov/apirequest/
//   USAJOBS_EMAIL    — the email registered with that key (sent as User-Agent)
// Without them, commands exit with a clear MISSING_API_KEY error.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { DEFAULT_CATEGORY } from "./helpers.js"

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

const HELP = `usajobs-cli — search US federal jobs via the official USAJOBS API

REQUIRES a free API key: set USAJOBS_API_KEY and USAJOBS_EMAIL
(request at https://developer.usajobs.gov/apirequest/).

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <control-number|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords (title, skill, agency).
  --location, -l <text>   Place string (e.g. "Dallas, Texas", "Texas").
  --remote                Only remote-designated positions (RemoteIndicator).
  --category <code>       JobCategoryCode. Default ${DEFAULT_CATEGORY} (IT Management
                          series). Pass "none" to search all series.
  --jobage <days>         Posted within N days (API caps at 60).
  --page <n>              1-indexed API page. Default 1.
  --limit, -n <n>         Results per page. Default 25.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <control-number|url>    The numeric id from search results, an announcement
                          number (PositionID), or a
                          https://www.usajobs.gov/job/<id> URL.

EXAMPLES
  bun run src/cli.ts search -q "software developer" -l Texas --jobage 30 --format table
  bun run src/cli.ts search -q "software" --remote --limit 10 --format table
  bun run src/cli.ts detail 834567800 --format plain

Federal remuneration is structured: salary_min/salary_max are USD per year
(hourly-rated positions keep salary_interval but null numbers).
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

function stringFlag(raw: string | boolean | string[] | undefined): string | undefined {
  return typeof raw === "string" ? raw : undefined
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

    const opts: SearchOpts = {
      query: stringFlag(flags.query),
      location: stringFlag(flags.location),
      remote: flags.remote === true,
      category: stringFlag(flags.category) ?? DEFAULT_CATEGORY,
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
      process.stderr.write(
        JSON.stringify({ error: "detail requires a <control-number|url>", code: "NO_ID" }) + "\n",
      )
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
