import {
  API_URL,
  MISSING_KEY_MESSAGE,
  apiGet,
  credentials,
  toResult,
  writeError,
  type JobResult,
  type UsaJobsResponse,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  remote?: boolean
  category?: string // JobCategoryCode; "none" disables the default 2210
  jobage: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export function buildUrl(opts: SearchOpts): string {
  const params = new URLSearchParams()
  if (opts.query) params.set("Keyword", opts.query)
  if (opts.location) params.set("LocationName", opts.location)
  if (opts.category && opts.category.toLowerCase() !== "none") {
    params.set("JobCategoryCode", opts.category)
  }
  if (opts.remote) params.set("RemoteIndicator", "True")
  // The API caps DatePosted at 60 days.
  if (opts.jobage > 0 && opts.jobage < 9999) params.set("DatePosted", String(Math.min(60, opts.jobage)))
  params.set("ResultsPerPage", String(opts.limit))
  params.set("Page", String(opts.page))
  return `${API_URL}?${params.toString()}`
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const idW = Math.max(2, ...rows.map((r) => r.id.length))
  const cells = (r: JobResult) =>
    [
      r.id.padEnd(idW),
      (r.title || "").slice(0, 36).padEnd(36),
      (r.company ?? "—").slice(0, 26).padEnd(26),
      (r.location ?? "—").slice(0, 22).padEnd(22),
      r.salary_min !== null ? `${Math.round(r.salary_min / 1000)}k`.padEnd(5) : "—".padEnd(5),
      r.close_date ?? "—",
    ].join("  ")
  const header = ["ID".padEnd(idW), "TITLE".padEnd(36), "AGENCY".padEnd(26), "LOCATION".padEnd(22), "SAL".padEnd(5), "CLOSES"].join("  ")
  return [header, "-".repeat(header.length), ...rows.map(cells)].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [
        r.title,
        `  ${r.company ?? "—"} · ${r.location ?? "—"} · posted ${r.date ?? "—"} · closes ${r.close_date ?? "—"}`,
        r.salary_min !== null
          ? `  salary: ${r.salary_min}–${r.salary_max} USD (${r.salary_interval ?? "Per Year"})`
          : "",
        `  id: ${r.id}`,
        `  ${r.url}`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  const creds = credentials()
  if (!creds) {
    writeError(MISSING_KEY_MESSAGE, "MISSING_API_KEY")
    return 1
  }
  try {
    const body = await apiGet<UsaJobsResponse>(buildUrl(opts), creds)
    const items = body.SearchResult?.SearchResultItems ?? []
    const rows = items.map(toResult)

    if (opts.format === "table") {
      process.stdout.write(renderTable(rows) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(rows) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            meta: {
              count: rows.length,
              page: opts.page,
              total: body.SearchResult?.SearchResultCountAll ?? rows.length,
            },
            results: rows,
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
