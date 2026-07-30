#!/usr/bin/env bun
// Self-contained CLI for the We Work Remotely public RSS feeds. Zero runtime
// dependencies — runs anywhere `bun` is available. Feeds are cached for 1 hour
// so a search→detail workflow makes at most a couple of requests.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { DEFAULT_CATEGORY, FEEDS } from "./helpers.js"

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

const HELP = `weworkremotely-cli — search We Work Remotely's RSS job feeds

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <slug|url> [--category <cat>] [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords matched against title/company/category/description.
  --location, -l <text>   Region substring (feeds carry regions like
                          "Anywhere in the World", "USA Only", "North America Only").
  --category <cat>        ${Object.keys(FEEDS).join(" | ")}. Default ${DEFAULT_CATEGORY}.
  --jobage <days>         Posted within N days.
  --page <n>              1-indexed page over the filtered feed. Default 1.
  --limit, -n <n>         Page size. Default 25.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <slug|url>              A slug from search results (the id) or a full
                          https://weworkremotely.com/remote-jobs/<slug> URL.
                          Falls back to the all-jobs feed if the slug is not in
                          the requested category.

EXAMPLES
  bun run src/cli.ts search -q react --jobage 14 --format table
  bun run src/cli.ts search --category full-stack -l "usa" --limit 10 --format table
  bun run src/cli.ts detail tether-ai-research-engineer --format plain

All jobs are remote by definition. Salary appears only when the posting text
carries an explicit dollar range.
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

  const category = stringFlag(flags.category) ?? DEFAULT_CATEGORY
  if (!(category in FEEDS)) {
    process.stderr.write(
      JSON.stringify({
        error: `--category must be one of ${Object.keys(FEEDS).join("|")}, got "${category}"`,
        code: "BAD_ARG",
      }) + "\n",
    )
    return 1
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
      category,
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
      process.stderr.write(JSON.stringify({ error: "detail requires a <slug|url>", code: "NO_ID" }) + "\n")
      return 1
    }
    const fmt = (flags.format as string) || "json"
    const opts: DetailOpts = { id, category, format: fmt === "plain" ? "plain" : "json" }
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
