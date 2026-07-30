// Data source: the RemoteOK public JSON feed (https://remoteok.com/api).
// One GET returns the whole board (~100 most recent remote jobs); the first
// array element is a metadata/legal notice, not a job. Their API terms ask for
// a link back to the RemoteOK job URL and to keep request volume low — so the
// CLI caches the feed to .cache.json for 6 hours and always emits the
// remoteok.com `url` as each result's canonical link.

import { join } from "path"

export const FEED_URL = "https://remoteok.com/api"

const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h — respect their feed

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "remoteok-search-skill/1.0 (personal job search; links back to remoteok.com)"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET the feed with exponential backoff on 429/5xx. */
export async function fetchFeed(): Promise<unknown[]> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(FEED_URL, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`RemoteOK request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (!response.ok) {
      throw new Error(`RemoteOK request failed: ${response.status} ${response.statusText}`)
    }
    const body = (await response.json().catch(() => null)) as unknown
    if (!Array.isArray(body)) throw new Error("RemoteOK feed was not a JSON array")
    return body
  }
  throw new Error("RemoteOK request failed after max retries")
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function cacheFile(): string {
  const env = (process.env.REMOTEOK_CACHE_FILE ?? "").trim()
  if (env) return env
  return join(import.meta.dir, "..", ".cache.json")
}

interface CacheShape {
  fetched_at: string
  jobs: RemoteOKJob[]
}

/**
 * The feed, from the 6h cache when fresh, otherwise fetched live and cached.
 * The metadata/legal first element (no id/position) is stripped before caching.
 */
export async function loadFeed(): Promise<{ jobs: RemoteOKJob[]; fromCache: boolean }> {
  const path = cacheFile()
  try {
    const file = Bun.file(path)
    if (await file.exists()) {
      const cached = (await file.json()) as CacheShape
      const age = Date.now() - new Date(cached.fetched_at).getTime()
      if (Array.isArray(cached.jobs) && isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
        return { jobs: cached.jobs, fromCache: true }
      }
    }
  } catch {
    // Unreadable cache: fall through to a live fetch.
  }

  const raw = await fetchFeed()
  const jobs = raw.filter(isJob)
  try {
    await Bun.write(path, JSON.stringify({ fetched_at: new Date().toISOString(), jobs }))
  } catch {
    // A read-only filesystem must not break the search.
  }
  return { jobs, fromCache: false }
}

export interface RemoteOKJob {
  id?: string | number
  slug?: string
  position?: string
  company?: string
  location?: string
  tags?: string[]
  date?: string
  epoch?: number
  url?: string
  apply_url?: string
  description?: string
  salary_min?: number
  salary_max?: number
}

/** True for real job entries; the feed's first element is a legal notice. */
export function isJob(entry: unknown): entry is RemoteOKJob {
  return (
    !!entry &&
    typeof entry === "object" &&
    "id" in entry &&
    "position" in entry &&
    typeof (entry as RemoteOKJob).position === "string"
  )
}

// ---------------------------------------------------------------------------
// Portal-contract result shapes
// ---------------------------------------------------------------------------

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
  tags: string[]
}

export interface JobDetailResult extends JobResult {
  apply_url: string | null
  description: string | null
}

/** The YYYY-MM-DD date portion of an ISO timestamp string, or null. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

export function toResult(j: RemoteOKJob): JobResult {
  // The feed serializes "no salary" as salary_min/max of 0.
  const min = typeof j.salary_min === "number" && j.salary_min > 0 ? j.salary_min : null
  const max = typeof j.salary_max === "number" && j.salary_max > 0 ? j.salary_max : null
  return {
    id: String(j.id ?? j.slug ?? ""),
    title: j.position ?? "(untitled)",
    company: j.company || null,
    location: j.location || null,
    date: isoDate(j.date) ?? (j.epoch ? new Date(j.epoch * 1000).toISOString().slice(0, 10) : null),
    url: j.url || (j.slug ? `https://remoteok.com/remote-jobs/${j.slug}` : ""),
    remote_type: "remote", // the whole board is remote-first
    salary_min: min,
    salary_max: max,
    salary_currency: min !== null || max !== null ? "USD" : null,
    tags: Array.isArray(j.tags) ? j.tags : [],
  }
}

export function toDetail(j: RemoteOKJob): JobDetailResult {
  return {
    ...toResult(j),
    apply_url: j.apply_url ? `https://remoteok.com${j.apply_url.startsWith("/") ? j.apply_url : `/${j.apply_url}`}` : null,
    description: htmlToText(j.description),
  }
}

// ---------------------------------------------------------------------------
// Matching + text utilities
// ---------------------------------------------------------------------------

/** Every query word must appear in the job's title/company/tags/description. */
export function jobMatchesQuery(j: RemoteOKJob, query: string): boolean {
  const haystack = [j.position, j.company, (j.tags ?? []).join(" "), j.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => haystack.includes(w))
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
}

export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr|table)>/gi, "\n")
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}
