#!/usr/bin/env bun
// Self-contained CLI for the Remotive public jobs API. Zero runtime
// dependencies — runs anywhere `bun` is available.
//
// HARD POLITENESS LIMIT: Remotive asks API users to poll at most a couple of
// times per day. The CLI fetches one category listing (no server-side search
// params), caches it for 12 hours, and filters client-side — so normal use
// makes at most ~2 real requests/day per category. Do not weaken the cache.

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

const DEFAULT_CATEGORY = "software-dev"

const HELP = `remotive-cli — search Remotive's remote-jobs API (12h cache, strict politeness)

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--category <cat>] [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords matched against title/company/tags (client-side).
  --location, -l <text>   candidate_required_location filter. "USA" also matches
                          Worldwide/Anywhere/Americas postings a US candidate fits.
  --category <cat>        Remotive category slug. Default ${DEFAULT_CATEGORY}.
                          (Others: data, devops, product, design, marketing, ...)
  --jobage <days>         Posted within N days.
  --page <n>              1-indexed page over the filtered listing. Default 1.
  --limit, -n <n>         Page size. Default 25.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <id|url>                A numeric id from search results or a
                          https://remotive.com/remote-jobs/... URL. Served from
                          the same cached listing (pass the same --category).

EXAMPLES
  bun run src/cli.ts search -q react -l USA --jobage 14 --format table
  bun run src/cli.ts search --category data -q python --limit 10 --format table
  bun run src/cli.ts detail 2090903 --format plain

Salary is Remotive free text; annual-looking ranges are parsed into
salary_min/salary_max/salary_currency, the raw string is kept in salary_raw.
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
      process.stderr.write(JSON.stringify({ error: "detail requires an <id|url>", code: "NO_ID" }) + "\n")
      return 1
    }
    const fmt = (flags.format as string) || "json"
    const opts: DetailOpts = {
      id,
      category: stringFlag(flags.category) ?? DEFAULT_CATEGORY,
      format: fmt === "plain" ? "plain" : "json",
    }
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
