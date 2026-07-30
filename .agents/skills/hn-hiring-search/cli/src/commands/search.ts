import {
  loadThread,
  parseComment,
  writeError,
  type JobDetailResult,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  remote?: string // remote | hybrid | onsite
  thread?: string // explicit thread id (default: latest "Who is hiring?")
  jobage: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export function applyFilters(rows: JobDetailResult[], opts: SearchOpts): JobDetailResult[] {
  let out = rows
  if (opts.query) {
    const words = opts.query.toLowerCase().split(/\s+/).filter(Boolean)
    out = out.filter((r) => {
      const hay = `${r.title} ${r.company ?? ""} ${r.description ?? ""}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }
  if (opts.location) {
    const l = opts.location.toLowerCase()
    out = out.filter(
      (r) =>
        (r.location ?? "").toLowerCase().includes(l) ||
        (r.description ?? "").split("\n")[0].toLowerCase().includes(l),
    )
  }
  if (opts.remote) out = out.filter((r) => r.remote_type === opts.remote)
  if (opts.jobage > 0 && opts.jobage < 9999) {
    const cutoff = new Date(Date.now() - opts.jobage * 86400_000).toISOString().slice(0, 10)
    out = out.filter((r) => r.date === null || r.date >= cutoff)
  }
  return out
}

/** Search results omit the (long) description; detail returns it in full. */
function toSearchRow(r: JobDetailResult): Omit<JobDetailResult, "description"> & { snippet: string | null } {
  const { description, ...rest } = r
  const snippet = description ? description.replace(/\n+/g, " ").slice(0, 220) : null
  return { ...rest, snippet }
}

function renderTable(rows: JobDetailResult[]): string {
  if (rows.length === 0) return "No results."
  const cells = (r: JobDetailResult) =>
    [
      r.id.padEnd(9),
      (r.company ?? "—").slice(0, 24).padEnd(24),
      (r.title || "").slice(0, 38).padEnd(38),
      (r.location ?? "—").slice(0, 20).padEnd(20),
      (r.remote_type ?? "—").padEnd(7),
      r.date ?? "—",
    ].join("  ")
  const header = ["ID".padEnd(9), "COMPANY".padEnd(24), "ROLE".padEnd(38), "LOCATION".padEnd(20), "WORK".padEnd(7), "DATE"].join("  ")
  return [header, "-".repeat(header.length), ...rows.map(cells)].join("\n")
}

function renderPlain(rows: JobDetailResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [
        `${r.company ?? "—"} — ${r.title}`,
        `  ${r.location ?? "—"} · ${r.remote_type ?? "—"} · ${r.date ?? "—"}`,
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
    const { id, title, comments, fromCache } = await loadThread(opts.thread)
    const parsed = comments.map(parseComment)
    const rows = applyFilters(parsed, opts)
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
              thread_id: id,
              thread_title: title,
              cached: fromCache,
            },
            results: pageRows.map(toSearchRow),
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
