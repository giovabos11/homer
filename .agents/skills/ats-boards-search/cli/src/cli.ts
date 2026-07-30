#!/usr/bin/env bun
// Self-contained CLI sweeping per-company public ATS job boards (Greenhouse,
// Lever, Ashby). Official JSON APIs, no authentication, zero runtime
// dependencies — it runs anywhere `bun` is available.
//
// The company registry lives in ../companies.json ([{slug, ats, name}]).
// Politeness: the sweep is sequential with a hard global cap of ~2 requests/s.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { ATS_KINDS } from "./helpers.js"

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

const HELP = `ats-boards-cli — sweep per-company public ATS job boards (Greenhouse, Lever, Ashby)

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <ats>:<company-slug>:<job-id> [--format json|plain]
  bun run src/cli.ts detail <board-url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Title keywords (every word must match). Recommended.
  --location, -l <text>   Location substring filter (e.g. "Dallas", "New York").
  --remote <mode>         remote | hybrid | onsite. Bare --remote means remote.
  --ats <kind>            Only sweep one ATS: greenhouse | lever | ashby.
  --companies <slugs>     Comma-separated company slugs to sweep (skip the rest).
  --jobage <days>         Posted within N days (undated jobs pass through).
  --page <n>              1-indexed company batch (the sweep is paged by company,
                          not by job — see --batch). Default 1.
  --batch <n>             Companies swept per page. Default 40.
  --limit, -n <n>         Cap results emitted (client-side).
  --format <fmt>          json (default) | table | plain.

DETAIL
  <id|url>                A search result id like "greenhouse:stripe:7954688",
                          or a boards.greenhouse.io / jobs.lever.co /
                          jobs.ashbyhq.com job URL.

EXAMPLES
  bun run src/cli.ts search -q "software engineer" --remote --limit 20 --format table
  bun run src/cli.ts search -q react --location "Dallas" --page 2 --format table
  bun run src/cli.ts search --companies stripe,figma,linear -q engineer --format json
  bun run src/cli.ts detail greenhouse:stripe:7954688 --format plain

The sweep is sequential and rate-capped (~2 req/s). One page of the default
batch (40 companies) takes ~20-30 seconds; use --companies or --ats to narrow.
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

    for (const name of ["jobage", "page", "limit", "batch"] as const) {
      if (flags[name] !== undefined) {
        const v = parseIntFlag(name, flags[name])
        if (v === null) return 1
        flags[name] = String(v)
      }
    }

    const ats = stringFlag(flags.ats)
    if (ats !== undefined && !ATS_KINDS.includes(ats as (typeof ATS_KINDS)[number])) {
      process.stderr.write(
        JSON.stringify({ error: `--ats must be one of ${ATS_KINDS.join("|")}, got "${ats}"`, code: "BAD_ARG" }) + "\n",
      )
      return 1
    }

    const remote = stringFlag(flags.remote, "remote")
    if (remote !== undefined && !["remote", "hybrid", "onsite"].includes(remote)) {
      process.stderr.write(
        JSON.stringify({ error: `--remote must be remote|hybrid|onsite, got "${remote}"`, code: "BAD_ARG" }) + "\n",
      )
      return 1
    }

    const companiesRaw = stringFlag(flags.companies) ?? ""
    const opts: SearchOpts = {
      query: stringFlag(flags.query),
      location: stringFlag(flags.location),
      remote,
      ats,
      companies: companiesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : 9999,
      page: flags.page ? Math.max(1, parseInt(flags.page as string, 10)) : 1,
      batch: flags.batch ? Math.max(1, parseInt(flags.batch as string, 10)) : 40,
      limit: flags.limit ? Math.max(0, parseInt(flags.limit as string, 10)) : undefined,
      format: (["json", "table", "plain"].includes(fmt) ? fmt : "json") as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) {
      process.stderr.write(
        JSON.stringify({ error: "detail requires <ats>:<slug>:<job-id> or a board URL", code: "NO_ID" }) + "\n",
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
