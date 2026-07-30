// Data source: the Remotive public API (https://remotive.com/api/remote-jobs).
// Remotive's API guidelines are strict: poll at most a couple of times per day
// and link back to the Remotive job URL. This CLI therefore fetches one
// category listing at a time WITHOUT server-side search params, caches it for
// 12 hours (max ~2 real fetches/day per category), and does all query/location
// filtering client-side against the cache.

import { join } from "path"

export const API_URL = "https://remotive.com/api/remote-jobs"

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h — HARD politeness limit

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "remotive-search-skill/1.0 (personal job search; links back to remotive.com)"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface RemotiveJob {
  id: number
  url: string
  title: string
  company_name?: string
  category?: string
  tags?: string[]
  job_type?: string
  publication_date?: string
  candidate_required_location?: string
  salary?: string
  description?: string
}

/** GET one category listing with exponential backoff on 429/5xx. */
export async function fetchCategory(category: string): Promise<RemotiveJob[]> {
  const url = `${API_URL}?category=${encodeURIComponent(category)}`
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
        throw new Error(`Remotive request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (!response.ok) {
      throw new Error(`Remotive request failed: ${response.status} ${response.statusText}`)
    }
    const body = (await response.json().catch(() => null)) as { jobs?: RemotiveJob[] } | null
    if (!body || !Array.isArray(body.jobs)) {
      throw new Error("Remotive response did not carry a jobs array")
    }
    return body.jobs
  }
  throw new Error("Remotive request failed after max retries")
}

// ---------------------------------------------------------------------------
// Cache (per category, 12h TTL)
// ---------------------------------------------------------------------------

export function cacheFile(): string {
  const env = (process.env.REMOTIVE_CACHE_FILE ?? "").trim()
  if (env) return env
  return join(import.meta.dir, "..", ".cache.json")
}

interface CacheShape {
  categories: Record<string, { fetched_at: string; jobs: RemotiveJob[] }>
}

export async function loadCategory(category: string): Promise<{ jobs: RemotiveJob[]; fromCache: boolean }> {
  const path = cacheFile()
  let cache: CacheShape = { categories: {} }
  try {
    const file = Bun.file(path)
    if (await file.exists()) {
      const parsed = (await file.json()) as CacheShape
      if (parsed && typeof parsed.categories === "object") cache = parsed
    }
  } catch {
    // Unreadable cache: refetch below.
  }

  const entry = cache.categories[category]
  if (entry && Array.isArray(entry.jobs)) {
    const age = Date.now() - new Date(entry.fetched_at).getTime()
    if (isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
      return { jobs: entry.jobs, fromCache: true }
    }
  }

  const jobs = await fetchCategory(category)
  cache.categories[category] = { fetched_at: new Date().toISOString(), jobs }
  try {
    await Bun.write(path, JSON.stringify(cache))
  } catch {
    // A read-only filesystem must not break the search.
  }
  return { jobs, fromCache: false }
}

// ---------------------------------------------------------------------------
// Portal-contract result shapes
// ---------------------------------------------------------------------------

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null // candidate_required_location
  date: string | null
  url: string
  remote_type: string | null
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  salary_raw: string | null
  job_type: string | null
  tags: string[]
}

export interface JobDetailResult extends JobResult {
  description: string | null
}

export function isoDate(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/\$|usd/i, "USD"],
  [/€|eur/i, "EUR"],
  [/£|gbp/i, "GBP"],
]

/**
 * Parse Remotive's free-text salary string ("$130,000 - $160,000/yr",
 * "$140k-$180k", ...). Only annual-looking amounts (≥ 1000 after k-expansion)
 * become numeric salary fields — hourly/daily rates stay in salary_raw only,
 * so they never pollute annual salary ranking.
 */
export function parseSalaryString(raw: string | null | undefined): {
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
} {
  const none = { salary_min: null, salary_max: null, salary_currency: null }
  if (!raw || typeof raw !== "string" || !raw.trim()) return none
  if (/(\/|\bper\s*)(hr|hour|day|week)\b/i.test(raw)) return none

  const nums: number[] = []
  const numRe = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?/g
  let m: RegExpExecArray | null
  while ((m = numRe.exec(raw)) !== null && nums.length < 2) {
    let v = parseFloat(m[1].replace(/,/g, ""))
    if (m[2]) v *= 1000
    nums.push(Math.round(v))
  }
  const annual = nums.filter((v) => v >= 1000)
  if (annual.length === 0) return none

  const currency = CURRENCY_SYMBOLS.find(([re]) => re.test(raw))?.[1] ?? null
  const min = Math.min(...annual)
  const max = Math.max(...annual)
  return { salary_min: min, salary_max: max === min && annual.length === 1 ? null : max, salary_currency: currency }
}

export function toResult(j: RemotiveJob): JobResult {
  return {
    id: String(j.id),
    title: j.title ?? "(untitled)",
    company: j.company_name || null,
    location: j.candidate_required_location || null,
    date: isoDate(j.publication_date),
    url: j.url ?? "",
    remote_type: "remote", // the whole board is remote-only
    ...parseSalaryString(j.salary),
    salary_raw: j.salary?.trim() || null,
    job_type: j.job_type || null,
    tags: Array.isArray(j.tags) ? j.tags : [],
  }
}

export function toDetail(j: RemotiveJob): JobDetailResult {
  return { ...toResult(j), description: htmlToText(j.description) }
}

// ---------------------------------------------------------------------------
// Matching + text utilities
// ---------------------------------------------------------------------------

/** Every query word must appear in title/company/tags. */
export function jobMatchesQuery(j: RemotiveJob, query: string): boolean {
  const haystack = [j.title, j.company_name, (j.tags ?? []).join(" ")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => haystack.includes(w))
}

/**
 * candidate_required_location filter. A US-flavored wanted value ("us", "usa",
 * "united states") also matches Worldwide/Anywhere/Americas-style postings a
 * US candidate is eligible for.
 */
export function matchesLocation(candidateLocation: string | undefined, wanted: string): boolean {
  const have = (candidateLocation ?? "").toLowerCase()
  const want = wanted.toLowerCase().trim()
  if (!want) return true
  if (have.includes(want)) return true
  if (["us", "usa", "united states"].includes(want)) {
    return /worldwide|anywhere|north(?:ern)? america|americas|usa|united states|\bus\b/i.test(have)
  }
  return false
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
