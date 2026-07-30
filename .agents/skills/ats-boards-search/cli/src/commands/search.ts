import {
  ASHBY_BASE,
  GREENHOUSE_BASE,
  LEVER_BASE,
  apiGet,
  loadCompanies,
  mapAshbyJob,
  mapGreenhouseJob,
  mapLeverJob,
  writeError,
  type AshbyJob,
  type Company,
  type GreenhouseJob,
  type JobResult,
  type LeverPosting,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  remote?: string // remote | hybrid | onsite
  ats?: string // greenhouse | lever | ashby
  companies: string[] // restrict sweep to these slugs (empty = all)
  jobage: number
  page: number // 1-indexed batch of companies
  batch: number // companies swept per page
  limit?: number
  format: "json" | "table" | "plain"
}

async function fetchCompanyJobs(c: Company): Promise<JobResult[]> {
  if (c.ats === "greenhouse") {
    const body = await apiGet<{ jobs?: GreenhouseJob[] }>(`${GREENHOUSE_BASE}/${c.slug}/jobs`)
    if (!body) throw new Error("board not found (404)")
    return (body.jobs ?? []).map((j) => mapGreenhouseJob(c, j))
  }
  if (c.ats === "lever") {
    const body = await apiGet<LeverPosting[]>(`${LEVER_BASE}/${c.slug}?mode=json`)
    if (!body) throw new Error("board not found (404)")
    if (!Array.isArray(body)) throw new Error("unexpected Lever response shape")
    return body.map((p) => mapLeverJob(c, p))
  }
  const body = await apiGet<{ jobs?: AshbyJob[] }>(
    `${ASHBY_BASE}/${c.slug}?includeCompensation=true`,
  )
  if (!body) throw new Error("board not found (404)")
  return (body.jobs ?? []).filter((j) => j.isListed !== false).map((j) => mapAshbyJob(c, j))
}

/** Every whitespace-separated query word must appear in the title. */
export function titleMatches(title: string, query: string): boolean {
  const t = title.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w))
}

export function applyFilters(rows: JobResult[], opts: SearchOpts): JobResult[] {
  let out = rows
  if (opts.query) out = out.filter((r) => titleMatches(r.title, opts.query!))
  if (opts.location) {
    const l = opts.location.toLowerCase()
    out = out.filter((r) => (r.location ?? "").toLowerCase().includes(l))
  }
  if (opts.remote) out = out.filter((r) => r.remote_type === opts.remote)
  if (opts.jobage > 0 && opts.jobage < 9999) {
    const cutoff = new Date(Date.now() - opts.jobage * 86400_000).toISOString().slice(0, 10)
    // Jobs with no readable date pass through (flagged downstream as date-unknown).
    out = out.filter((r) => r.date === null || r.date >= cutoff)
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
      (r.company ?? "—").slice(0, 18).padEnd(18),
      (r.location ?? "—").slice(0, 24).padEnd(24),
      r.date ?? "—",
    ].join("  ")
  const header = ["ID".padEnd(idW), "TITLE".padEnd(40), "COMPANY".padEnd(18), "LOCATION".padEnd(24), "DATE"].join("  ")
  return [header, "-".repeat(header.length), ...rows.map(cells)].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [
        r.title,
        `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${r.date ?? "—"}${r.remote_type ? ` · ${r.remote_type}` : ""}`,
        r.salary_min !== null || r.salary_max !== null
          ? `  salary: ${r.salary_min ?? "?"}–${r.salary_max ?? "?"} ${r.salary_currency ?? ""}`.trimEnd()
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
  try {
    let companies = await loadCompanies()
    if (opts.ats) companies = companies.filter((c) => c.ats === opts.ats)
    if (opts.companies.length > 0) {
      const want = new Set(opts.companies.map((s) => s.toLowerCase()))
      companies = companies.filter((c) => want.has(c.slug.toLowerCase()))
    }

    const batches = Math.max(1, Math.ceil(companies.length / opts.batch))
    const start = (opts.page - 1) * opts.batch
    const slice = companies.slice(start, start + opts.batch)

    const collected: JobResult[] = []
    const errors: Array<{ company: string; error: string }> = []
    for (const c of slice) {
      try {
        collected.push(...(await fetchCompanyJobs(c)))
      } catch (e) {
        errors.push({
          company: `${c.ats}:${c.slug}`,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (slice.length > 0 && errors.length === slice.length) {
      writeError(
        `all ${slice.length} company boards in this batch failed — first error (${errors[0].company}): ${errors[0].error}`,
        "SEARCH_FAILED",
      )
      return 1
    }

    let rows = applyFilters(collected, opts)
    // Newest first; undated rows sink to the bottom.
    rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    if (opts.limit !== undefined && opts.limit >= 0) rows = rows.slice(0, opts.limit)

    if (opts.format === "table") {
      process.stdout.write(renderTable(rows) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(rows) + "\n")
    } else {
      const meta: Record<string, unknown> = {
        count: rows.length,
        page: opts.page,
        batches,
        batch_size: opts.batch,
        companies_total: companies.length,
        companies_swept: slice.length,
      }
      if (errors.length > 0) meta.errors = errors
      process.stdout.write(JSON.stringify({ meta, results: rows }, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
