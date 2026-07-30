import {
  jobMatchesQuery,
  loadCategory,
  matchesLocation,
  toResult,
  writeError,
  type JobResult,
  type RemotiveJob,
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

export function filterJobs(jobs: RemotiveJob[], opts: SearchOpts): RemotiveJob[] {
  let out = jobs
  if (opts.query) out = out.filter((j) => jobMatchesQuery(j, opts.query!))
  if (opts.location) out = out.filter((j) => matchesLocation(j.candidate_required_location, opts.location!))
  if (opts.jobage > 0 && opts.jobage < 9999) {
    const cutoff = new Date(Date.now() - opts.jobage * 86400_000).toISOString().slice(0, 10)
    out = out.filter((j) => {
      const d = toResult(j).date
      return d === null || d >= cutoff
    })
  }
  return out
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const idW = Math.max(2, ...rows.map((r) => r.id.length))
  const cells = (r: JobResult) =>
    [
      r.id.padEnd(idW),
      (r.title || "").slice(0, 40).padEnd(40),
      (r.company ?? "—").slice(0, 20).padEnd(20),
      (r.location ?? "—").slice(0, 22).padEnd(22),
      r.date ?? "—",
    ].join("  ")
  const header = ["ID".padEnd(idW), "TITLE".padEnd(40), "COMPANY".padEnd(20), "LOCATION".padEnd(22), "DATE"].join("  ")
  return [header, "-".repeat(header.length), ...rows.map(cells)].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [
        r.title,
        `  ${r.company ?? "—"} · ${r.location ?? "remote"} · ${r.date ?? "—"}${r.job_type ? ` · ${r.job_type}` : ""}`,
        r.salary_raw ? `  salary: ${r.salary_raw}` : "",
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
    const { jobs, fromCache } = await loadCategory(opts.category)
    const filtered = filterJobs(jobs, opts)
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
