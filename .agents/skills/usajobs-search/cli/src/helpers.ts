// Data source: the official USAJOBS Search API (https://data.usajobs.gov).
// Requires a FREE API key (https://developer.usajobs.gov/apirequest/) sent as
// the Authorization-Key header, plus the registered email as User-Agent — both
// read from the environment (USAJOBS_API_KEY / USAJOBS_EMAIL), never files.
// Federal postings carry fully structured remuneration (salary) data.

export const API_URL = "https://data.usajobs.gov/api/search"

/** 2210 = the federal "Information Technology Management" occupational series. */
export const DEFAULT_CATEGORY = "2210"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export interface Credentials {
  apiKey: string
  email: string
}

/** API credentials from the environment, or null when not configured. */
export function credentials(): Credentials | null {
  const apiKey = (process.env.USAJOBS_API_KEY ?? "").trim()
  const email = (process.env.USAJOBS_EMAIL ?? "").trim()
  if (!apiKey || !email) return null
  return { apiKey, email }
}

export const MISSING_KEY_MESSAGE =
  "USAJOBS API credentials are not configured. Request a free key at https://developer.usajobs.gov/apirequest/, then set USAJOBS_API_KEY (the key) and USAJOBS_EMAIL (the email you registered) environment variables."

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET a USAJOBS endpoint with the auth headers and 429/5xx backoff. */
export async function apiGet<T>(url: string, creds: Credentials): Promise<T> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "Authorization-Key": creds.apiKey,
        "User-Agent": creds.email,
        Accept: "application/json",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`USAJOBS request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `USAJOBS rejected the credentials (${response.status}) — check USAJOBS_API_KEY / USAJOBS_EMAIL`,
      )
    }
    if (!response.ok) {
      throw new Error(`USAJOBS request failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
  }
  throw new Error("USAJOBS request failed after max retries")
}

// ---------------------------------------------------------------------------
// Wire + contract shapes
// ---------------------------------------------------------------------------

export interface Remuneration {
  MinimumRange?: string
  MaximumRange?: string
  RateIntervalCode?: string // "PA" per annum, "PH" per hour, ...
  Description?: string
}

export interface UsaJobsDescriptor {
  PositionID?: string // announcement number, e.g. "DE-12345-24-XY"
  PositionTitle?: string
  OrganizationName?: string
  DepartmentName?: string
  PositionLocationDisplay?: string
  PositionURI?: string
  ApplyURI?: string[]
  PublicationStartDate?: string
  ApplicationCloseDate?: string
  PositionRemuneration?: Remuneration[]
  PositionSchedule?: Array<{ Name?: string }>
  QualificationSummary?: string
  UserArea?: {
    Details?: {
      JobSummary?: string
      MajorDuties?: string[] | string
      Requirements?: string
      Education?: string
      RemoteIndicator?: boolean
      TeleworkEligible?: boolean
      HiringPath?: string[]
    }
  }
}

export interface UsaJobsItem {
  MatchedObjectId?: string // the control number (numeric string)
  MatchedObjectDescriptor?: UsaJobsDescriptor
}

export interface UsaJobsResponse {
  SearchResult?: {
    SearchResultCount?: number
    SearchResultCountAll?: number
    SearchResultItems?: UsaJobsItem[]
  }
}

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  remote_type: string | null
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  salary_interval: string | null
  close_date: string | null
}

export interface JobDetailResult extends JobResult {
  department: string | null
  position_id: string | null
  apply_url: string | null
  description: string | null
}

export function isoDate(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/**
 * Structured remuneration -> salary fields. Only annual ("PA") ranges become
 * numbers; hourly/other intervals keep the interval label but null numbers so
 * they never pollute annual salary ranking.
 */
export function parseRemuneration(rem: Remuneration[] | undefined): {
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  salary_interval: string | null
} {
  const none = { salary_min: null, salary_max: null, salary_currency: null, salary_interval: null }
  if (!Array.isArray(rem) || rem.length === 0) return none
  const annual = rem.find((r) => (r.RateIntervalCode ?? "").toUpperCase() === "PA") ?? rem[0]
  const interval = annual.Description ?? annual.RateIntervalCode ?? null
  const isAnnual = (annual.RateIntervalCode ?? "").toUpperCase() === "PA"
  const min = parseFloat(annual.MinimumRange ?? "")
  const max = parseFloat(annual.MaximumRange ?? "")
  if (!isAnnual || (!isFinite(min) && !isFinite(max))) {
    return { ...none, salary_interval: interval }
  }
  return {
    salary_min: isFinite(min) ? Math.round(min) : null,
    salary_max: isFinite(max) ? Math.round(max) : null,
    salary_currency: "USD",
    salary_interval: interval,
  }
}

export function remoteType(d: UsaJobsDescriptor): string | null {
  const details = d.UserArea?.Details
  if (details?.RemoteIndicator === true) return "remote"
  // Telework-eligible federal roles are office-anchored with home days — the
  // closest contract value is "hybrid".
  if (details?.TeleworkEligible === true) return "hybrid"
  return null
}

export function toResult(item: UsaJobsItem): JobResult {
  const d = item.MatchedObjectDescriptor ?? {}
  return {
    id: String(item.MatchedObjectId ?? d.PositionID ?? ""),
    title: d.PositionTitle ?? "(untitled)",
    company: d.OrganizationName || null,
    location: d.PositionLocationDisplay || null,
    date: isoDate(d.PublicationStartDate),
    url: d.PositionURI ?? "",
    remote_type: remoteType(d),
    ...parseRemuneration(d.PositionRemuneration),
    close_date: isoDate(d.ApplicationCloseDate),
  }
}

export function toDetail(item: UsaJobsItem): JobDetailResult {
  const d = item.MatchedObjectDescriptor ?? {}
  const details = d.UserArea?.Details
  const duties = Array.isArray(details?.MajorDuties)
    ? details?.MajorDuties.join("\n")
    : details?.MajorDuties
  const description =
    [
      details?.JobSummary,
      duties ? `Major duties:\n${duties}` : undefined,
      d.QualificationSummary ? `Qualifications:\n${d.QualificationSummary}` : undefined,
      details?.Requirements ? `Requirements:\n${details.Requirements}` : undefined,
    ]
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .join("\n\n") || null
  return {
    ...toResult(item),
    department: d.DepartmentName || null,
    position_id: d.PositionID || null,
    apply_url: d.ApplyURI?.[0] ?? null,
    description,
  }
}
