import {
  itemMatchesQuery,
  loadCategory,
  toResult,
  writeError,
  type FeedItem,
  type JobResult,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  category: string
  jobage: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export function filterItems(items: FeedItem[], opts: SearchOpts): FeedItem[] {
  let out = items
  if (opts.query) out = out.filter((i) => itemMatchesQuery(i, opts.query!))
  if (opts.location) {
    const l = opts.location.toLowerCase()
    out = out.filter((i) => (i.region ?? "").toLowerCase().includes(l))
  }
  if (opts.jobage > 0 && opts.jobage < 9999) {
    const cutoff = new Date(Date.now() - opts.jobage * 86400_000).toISOString().slice(0, 10)
    out = out.filter((i) => i.date === null || i.date >= cutoff)
  }
  return out
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const idW = Math.min(44, Math.max(2, ...rows.map((r) => r.id.length)))
  const cells = (r: JobResult) =>
    [
      r.id.slice(0, idW).padEnd(idW),
      (r.title || "").slice(0, 38).padEnd(38),
      (r.company ?? "—").slice(0, 20).padEnd(20),
      (r.location ?? "—").slice(0, 22).padEnd(22),
      r.date ?? "—",
    ].join("  ")
  const header = ["ID".padEnd(idW), "TITLE".padEnd(38), "COMPANY".padEnd(20), "LOCATION".padEnd(22), "DATE"].join("  ")
  return [header, "-".repeat(header.length), ...rows.map(cells)].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [
        r.title,
        `  ${r.company ?? "—"} · ${r.location ?? "remote"} · ${r.date ?? "—"}`,
        r.salary_min !== null ? `  salary: ${r.salary_min}–${r.salary_max} ${r.salary_currency}` : "",
        `  id: ${r.id}`,
        `  ${r.url}`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const { items, fromCache } = await loadCategory(opts.category)
    const filtered = filterItems(items, opts)
    const rows = filtered.map(toResult)
    rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    const start = (opts.page - 1) * opts.limit
    const pageRows = rows.slice(start, start + opts.limit)

    if (opts.format === "table") {
      process.stdout.write(renderTable(pageRows) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(pageRows) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            meta: {
              count: pageRows.length,
              page: opts.page,
              total: rows.length,
              category: opts.category,
              cached: fromCache,
            },
            results: pageRows,
          },
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
