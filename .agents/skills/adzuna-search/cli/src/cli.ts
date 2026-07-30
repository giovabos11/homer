#!/usr/bin/env bun
// Self-contained CLI for the Adzuna Jobs API (US). Zero runtime dependencies.
// Requires a FREE Adzuna app id + key in the environment:
//   ADZUNA_APP_ID / ADZUNA_APP_KEY   (get one at https://developer.adzuna.com)
// Without them, search exits with a clear MISSING_API_KEY error.

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

const HELP = `adzuna-cli — search the Adzuna Jobs API (US, salary-annotated)

REQUIRES a free API key: set ADZUNA_APP_ID and ADZUNA_APP_KEY
(register at https://developer.adzuna.com).

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords (title, skill, role).
  --location, -l <text>   Place string (e.g. "Dallas, TX", "Texas", "New York").
  --remote                Convenience: appends "remote" to the query.
  --jobage <days>         Posted within N days (maps to max_days_old).
  --page <n>              1-indexed API page. Default 1.
  --limit, -n <n>         Results per page (max 50). Default 25.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <id|url>                An id from search results or an adzuna.com job URL.
                          Served from the local result cache — Adzuna's API has
                          no fetch-by-id endpoint, so run a search that returns
                          the job first.

EXAMPLES
  bun run src/cli.ts search -q "software engineer" -l "Dallas, TX" --jobage 14 --format table
  bun run src/cli.ts search -q "react developer" --remote --limit 10 --format table
  bun run src/cli.ts detail 5219438123 --format plain

salary_min/salary_max are USD; salary_is_predicted marks Adzuna's estimates.
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
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : 9999,
      page: flags.page ? Math.max(1, parseInt(flags.page as string, 10)) : 1,
      limit: flags.limit ? Math.min(50, Math.max(1, parseInt(flags.limit as string, 10))) : 25,
      format: (["json", "table", "plain"].includes(fmt) ? fmt : "json") as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) {
      process.stderr.write(JSON.stringify({ error: "detail requires an <id|url>", code: "NO_ID" }) + "\n")
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
