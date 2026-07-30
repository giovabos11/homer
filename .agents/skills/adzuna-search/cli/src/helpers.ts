// Data source: the Adzuna Jobs API (US country endpoint). Requires a FREE
// app id + key from https://developer.adzuna.com — read from the environment
// (ADZUNA_APP_ID / ADZUNA_APP_KEY), never from files. Salary data is a first-
// class field here, including Adzuna's predicted-salary flag.
//
// Adzuna has no fetch-by-id endpoint, so `search` caches every result by id
// and `detail` answers from that cache (see url-reference.md).

import { join } from "path"

export const API_BASE = "https://api.adzuna.com/v1/api/jobs/us/search"

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // detail lookups stay valid for a week
const CACHE_MAX_ENTRIES = 500

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "adzuna-search-skill/1.0 (personal job search)"

export interface Credentials {
  appId: string
  appKey: string
}

/** The API credentials from the environment, or null when not configured. */
export function credentials(): Credentials | null {
  const appId = (process.env.ADZUNA_APP_ID ?? "").trim()
  const appKey = (process.env.ADZUNA_APP_KEY ?? "").trim()
  if (!appId || !appKey) return null
  return { appId, appKey }
}

export const MISSING_KEY_MESSAGE =
  "Adzuna API credentials are not configured. Get a free key at https://developer.adzuna.com, then set the ADZUNA_APP_ID and ADZUNA_APP_KEY environment variables."

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET a JSON endpoint with exponential backoff on 429/5xx. */
export async function apiGet<T>(url: string): Promise<T> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Adzuna request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Adzuna rejected the credentials (${response.status}) — check ADZUNA_APP_ID / ADZUNA_APP_KEY`,
      )
    }
    if (!response.ok) {
      throw new Error(`Adzuna request failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
  }
  throw new Error("Adzuna request failed after max retries")
}

// ---------------------------------------------------------------------------
// Wire + contract shapes
// ---------------------------------------------------------------------------

export interface AdzunaJob {
  id: string | number
  title?: string
  company?: { display_name?: string }
  location?: { display_name?: string }
  created?: string
  redirect_url?: string
  salary_min?: number
  salary_max?: number
  salary_is_predicted?: string | number // "1" when Adzuna estimated it
  description?: string
  contract_time?: string // full_time | part_time
  contract_type?: string // permanent | contract
  category?: { label?: string }
}

export interface AdzunaSearchResponse {
  count?: number
  results?: AdzunaJob[]
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
  salary_is_predicted: boolean
}

export interface JobDetailResult extends JobResult {
  employment_type: string | null
  category: string | null
  description: string | null
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
}

export function isoDate(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** Adzuna US has no workplace-type field; sniff "remote"/"hybrid" from text. */
export function sniffRemoteType(title: string, description: string | undefined): string | null {
  const hay = `${title} ${description ?? ""}`
  if (/\bremote\b/i.test(hay)) return "remote"
  if (/\bhybrid\b/i.test(hay)) return "hybrid"
  return null
}

export function toResult(j: AdzunaJob): JobResult {
  const title = stripTags(j.title ?? "(untitled)")
  const min = typeof j.salary_min === "number" && j.salary_min > 0 ? Math.round(j.salary_min) : null
  const max = typeof j.salary_max === "number" && j.salary_max > 0 ? Math.round(j.salary_max) : null
  return {
    id: String(j.id),
    title,
    company: j.company?.display_name || null,
    location: j.location?.display_name || null,
    date: isoDate(j.created),
    url: j.redirect_url ?? "",
    remote_type: sniffRemoteType(title, j.description),
    salary_min: min,
    salary_max: max,
    salary_currency: min !== null || max !== null ? "USD" : null,
    salary_is_predicted: String(j.salary_is_predicted ?? "0") === "1",
  }
}

export function toDetail(j: AdzunaJob): JobDetailResult {
  const employment = [j.contract_time, j.contract_type].filter(Boolean).join(", ")
  return {
    ...toResult(j),
    employment_type: employment || null,
    category: j.category?.label || null,
    description: j.description ? stripTags(j.description) : null,
  }
}

// ---------------------------------------------------------------------------
// Result cache (powers `detail` — Adzuna has no fetch-by-id endpoint)
// ---------------------------------------------------------------------------

export function cacheFile(): string {
  const env = (process.env.ADZUNA_CACHE_FILE ?? "").trim()
  if (env) return env
  return join(import.meta.dir, "..", ".cache.json")
}

interface CacheShape {
  jobs: Record<string, { cached_at: string; job: AdzunaJob }>
}

async function readCache(): Promise<CacheShape> {
  try {
    const file = Bun.file(cacheFile())
    if (await file.exists()) {
      const parsed = (await file.json()) as CacheShape
      if (parsed && typeof parsed.jobs === "object") return parsed
    }
  } catch {
    // Unreadable cache: start fresh.
  }
  return { jobs: {} }
}

/** Remember search results so `detail <id>` can answer without an API refetch. */
export async function rememberJobs(jobs: AdzunaJob[]): Promise<void> {
  const cache = await readCache()
  const now = new Date().toISOString()
  for (const job of jobs) {
    cache.jobs[String(job.id)] = { cached_at: now, job }
  }
  // Evict oldest entries beyond the cap.
  const ids = Object.keys(cache.jobs)
  if (ids.length > CACHE_MAX_ENTRIES) {
    ids
      .sort((a, b) => (cache.jobs[a].cached_at < cache.jobs[b].cached_at ? -1 : 1))
      .slice(0, ids.length - CACHE_MAX_ENTRIES)
      .forEach((old) => delete cache.jobs[old])
  }
  try {
    await Bun.write(cacheFile(), JSON.stringify(cache))
  } catch {
    // A read-only filesystem must not break the search.
  }
}

/** A previously-seen job by id, or null when never cached (or expired). */
export async function recallJob(id: string): Promise<AdzunaJob | null> {
  const cache = await readCache()
  const entry = cache.jobs[id]
  if (!entry) return null
  const age = Date.now() - new Date(entry.cached_at).getTime()
  if (!isFinite(age) || age < 0 || age > CACHE_TTL_MS) return null
  return entry.job
}
