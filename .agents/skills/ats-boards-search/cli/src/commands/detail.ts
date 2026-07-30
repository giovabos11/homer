import {
  ASHBY_BASE,
  GREENHOUSE_BASE,
  LEVER_BASE,
  apiGet,
  greenhouseSalary,
  htmlToText,
  loadCompanies,
  mapAshbyJob,
  mapGreenhouseJob,
  mapLeverJob,
  parseJobRef,
  writeError,
  type AshbyJob,
  type Company,
  type GreenhouseJob,
  type JobDetailResult,
  type JobRef,
  type LeverPosting,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

/** The registry entry for a slug, or a synthetic one so unlisted boards still work. */
async function resolveCompany(ref: JobRef): Promise<Company> {
  try {
    const companies = await loadCompanies()
    const hit = companies.find(
      (c) => c.ats === ref.ats && c.slug.toLowerCase() === ref.slug.toLowerCase(),
    )
    if (hit) return hit
  } catch {
    // Registry missing is fine for detail — the ref carries everything needed.
  }
  return { slug: ref.slug, ats: ref.ats, name: ref.slug }
}

async function fetchDetail(ref: JobRef): Promise<JobDetailResult | null> {
  const company = await resolveCompany(ref)

  if (ref.ats === "greenhouse") {
    const j = await apiGet<GreenhouseJob>(
      `${GREENHOUSE_BASE}/${ref.slug}/jobs/${ref.jobId}?questions=false`,
    )
    if (!j) return null
    const base = mapGreenhouseJob(company, j)
    // The list endpoint carries no pay data; the job endpoint may. Overwrite
    // with the detail response's pay ranges (still null when not published).
    const salary = greenhouseSalary(j.pay_input_ranges)
    return {
      ...base,
      ...salary,
      employment_type: null,
      // Greenhouse `content` is HTML-escaped HTML: htmlToText's entity pass
      // unescapes it, but tags then remain — so unescape first, then strip.
      description: htmlToText(unescapeGreenhouseContent(j.content)),
    }
  }

  if (ref.ats === "lever") {
    const p = await apiGet<LeverPosting>(`${LEVER_BASE}/${ref.slug}/${ref.jobId}`)
    if (!p || !p.id) return null
    const base = mapLeverJob(company, p)
    const description =
      [p.openingPlain, p.descriptionPlain, p.additionalPlain]
        .filter((s): s is string => typeof s === "string" && s.trim() !== "")
        .join("\n\n") || null
    return {
      ...base,
      employment_type: p.categories?.commitment ?? null,
      description,
    }
  }

  // Ashby has no per-job endpoint: fetch the board and pick the job out.
  const body = await apiGet<{ jobs?: AshbyJob[] }>(
    `${ASHBY_BASE}/${ref.slug}?includeCompensation=true`,
  )
  if (!body) return null
  const j = (body.jobs ?? []).find((job) => job.id === ref.jobId)
  if (!j) return null
  const base = mapAshbyJob(company, j)
  return {
    ...base,
    employment_type: j.employmentType ?? null,
    description: j.descriptionPlain?.trim() || htmlToText(j.descriptionHtml),
  }
}

/** Greenhouse serves `content` as HTML-escaped HTML; unescape the wrapper layer. */
function unescapeGreenhouseContent(content: string | undefined): string | null {
  if (!content) return null
  return content
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
}

function renderPlain(job: JobDetailResult): string {
  const salary =
    job.salary_min !== null || job.salary_max !== null
      ? `Salary: ${job.salary_min ?? "?"}–${job.salary_max ?? "?"} ${job.salary_currency ?? ""}`.trimEnd()
      : ""
  return [
    job.title,
    `${job.company ?? "—"} · ${job.location ?? "—"} · ${job.date ?? "—"}`,
    job.remote_type ? `Workplace: ${job.remote_type}` : "",
    job.employment_type ? `Employment: ${job.employment_type}` : "",
    salary,
    "",
    job.description ?? "(no description)",
    "",
    `id: ${job.id}`,
    `URL: ${job.url}`,
  ]
    .filter((l) => l !== "")
    .join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const ref = parseJobRef(opts.id)
  if (!ref) {
    writeError(
      `could not parse a job reference from "${opts.id}" — expected "<greenhouse|lever|ashby>:<company-slug>:<job-id>" or a boards.greenhouse.io / jobs.lever.co / jobs.ashbyhq.com URL`,
      "BAD_ID",
    )
    return 1
  }
  try {
    const job = await fetchDetail(ref)
    if (!job) {
      writeError(`job not found: ${ref.ats}:${ref.slug}:${ref.jobId}`, "NOT_FOUND")
      return 1
    }
    if (opts.format === "plain") {
      process.stdout.write(renderPlain(job) + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
