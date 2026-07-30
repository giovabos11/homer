import {
  API_URL,
  MISSING_KEY_MESSAGE,
  apiGet,
  credentials,
  toDetail,
  writeError,
  type JobDetailResult,
  type UsaJobsResponse,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

/** Accept a control number, an announcement PositionID, or a usajobs.gov URL. */
export function normalizeId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  const url = t.match(/usajobs\.gov\/(?:job|GetJob\/ViewDetails)\/(\d+)/i)
  if (url) return url[1]
  if (/^[\w-]+$/.test(t)) return t
  return null
}

function renderPlain(job: JobDetailResult): string {
  return [
    job.title,
    `${job.company ?? "—"}${job.department ? ` (${job.department})` : ""}`,
    `${job.location ?? "—"} · posted ${job.date ?? "—"} · closes ${job.close_date ?? "—"}`,
    job.remote_type ? `Workplace: ${job.remote_type}` : "",
    job.salary_min !== null
      ? `Salary: ${job.salary_min}–${job.salary_max} USD (${job.salary_interval ?? "Per Year"})`
      : "",
    job.position_id ? `Announcement: ${job.position_id}` : "",
    "",
    job.description ?? "(no description)",
    "",
    `id: ${job.id}`,
    `URL: ${job.url}`,
    job.apply_url ? `Apply: ${job.apply_url}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(`could not parse a USAJOBS id from "${opts.id}"`, "BAD_ID")
    return 1
  }
  const creds = credentials()
  if (!creds) {
    writeError(MISSING_KEY_MESSAGE, "MISSING_API_KEY")
    return 1
  }
  try {
    // No fetch-by-id endpoint: search the control number / announcement id as
    // a keyword, then match exactly on MatchedObjectId or PositionID.
    const params = new URLSearchParams({ Keyword: id, ResultsPerPage: "25" })
    const body = await apiGet<UsaJobsResponse>(`${API_URL}?${params.toString()}`, creds)
    const items = body.SearchResult?.SearchResultItems ?? []
    const hit = items.find(
      (i) =>
        String(i.MatchedObjectId ?? "") === id ||
        (i.MatchedObjectDescriptor?.PositionID ?? "").toLowerCase() === id.toLowerCase(),
    )
    if (!hit) {
      writeError(
        `job ${id} not found via USAJOBS keyword lookup — it may have closed, or pass the numeric control number from a search result's id`,
        "NOT_FOUND",
      )
      return 1
    }
    const job = toDetail(hit)
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
