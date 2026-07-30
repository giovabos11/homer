import {
  API_BASE,
  MISSING_KEY_MESSAGE,
  apiGet,
  credentials,
  rememberJobs,
  toResult,
  writeError,
  type AdzunaSearchResponse,
  type JobResult,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  remote?: boolean // convenience: appends "remote" to the query
  jobage: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
}

export function buildUrl(opts: SearchOpts, appId: string, appKey: string): string {
  const params = new URLSearchParams()
  params.set("app_id", appId)
  params.set("app_key", appKey)
  params.set("results_per_page", String(opts.limit))
  params.set("content-type", "application/json")
  const what = [opts.query, opts.remote ? "remote" : undefined].filter(Boolean).join(" ")
  if (what) params.set("what", what)
  if (opts.location) params.set("where", opts.location)
  if (opts.jobage > 0 && opts.jobage < 9999) params.set("max_days_old", String(opts.jobage))
  return `${API_BASE}/${opts.page}?${params.toString()}`
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const idW = Math.max(2, ...rows.map((r) => r.id.length))
  const cells = (r: JobResult) =>
    [
      r.id.padEnd(idW),
      (r.title || "").slice(0, 38).padEnd(38),
      (r.company ?? "—").slice(0, 20).padEnd(20),
      (r.location ?? "—").slice(0, 22).padEnd(22),
      r.salary_min !== null ? `${Math.round(r.salary_min / 1000)}k${r.salary_is_predicted ? "*" : ""}`.padEnd(6) : "—".padEnd(6),
      r.date ?? "—",
    ].join("  ")
  const header = ["ID".padEnd(idW), "TITLE".padEnd(38), "COMPANY".padEnd(20), "LOCATION".padEnd(22), "SAL".padEnd(6), "DATE"].join("  ")
  return [header, "-".repeat(header.length), ...rows.map(cells), "", "* = Adzuna-predicted salary"].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [
        r.title,
        `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${r.date ?? "—"}`,
        r.salary_min !== null || r.salary_max !== null
          ? `  salary: ${r.salary_min ?? "?"}–${r.salary_max ?? "?"} USD${r.salary_is_predicted ? " (predicted)" : ""}`
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
    const body = await apiGet<AdzunaSearchResponse>(buildUrl(opts, creds.appId, creds.appKey))
    const jobs = body.results ?? []
    // Cache raw results so `detail <id>` can answer without an API refetch.
    await rememberJobs(jobs)
    const rows = jobs.map(toResult)

    if (opts.format === "table") {
      process.stdout.write(renderTable(rows) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(rows) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            meta: { count: rows.length, page: opts.page, total: body.count ?? rows.length },
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
