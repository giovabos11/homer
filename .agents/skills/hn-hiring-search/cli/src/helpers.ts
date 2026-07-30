// Data source: the Hacker News Algolia API (https://hn.algolia.com/api).
// The monthly "Ask HN: Who is hiring?" thread is found via search_by_date
// (stories by the whoishiring bot), then fetched as one item tree; every
// TOP-LEVEL comment is one job posting. Postings follow a loose community
// convention — "Company | Role | Location | Salary | REMOTE/ONSITE" in the
// first line — which is regexed out best-effort; the full comment text is
// always available via `detail`.

import { join } from "path"

export const SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date"
export const ITEM_URL = "https://hn.algolia.com/api/v1/items"

const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h — the thread item tree is ~2MB

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "hn-hiring-search-skill/1.0 (personal job search)"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET a JSON endpoint with exponential backoff on 429/5xx. Null on 404. */
export async function apiGet<T>(url: string): Promise<T | null> {
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
        throw new Error(`HN Algolia request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`HN Algolia request failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
  }
  throw new Error("HN Algolia request failed after max retries")
}

// ---------------------------------------------------------------------------
// Thread discovery + fetch
// ---------------------------------------------------------------------------

interface AlgoliaHit {
  objectID: string
  title?: string
  created_at?: string
}

/** The newest "Ask HN: Who is hiring?" story by the whoishiring bot. */
export async function findLatestThread(): Promise<{ id: string; title: string }> {
  const body = await apiGet<{ hits?: AlgoliaHit[] }>(
    `${SEARCH_URL}?tags=story,author_whoishiring&hitsPerPage=10`,
  )
  const hit = (body?.hits ?? []).find((h) => /who is hiring/i.test(h.title ?? ""))
  if (!hit) throw new Error('could not find a recent "Ask HN: Who is hiring?" thread')
  return { id: hit.objectID, title: hit.title ?? "Ask HN: Who is hiring?" }
}

export interface HNComment {
  id: number
  author: string | null
  created_at: string | null
  text: string | null // HTML
}

interface AlgoliaItem {
  id: number
  title?: string
  author?: string
  created_at?: string
  text?: string | null
  children?: AlgoliaItem[]
}

/** The thread's top-level comments (each one job posting). */
export async function fetchThreadComments(threadId: string): Promise<{ title: string; comments: HNComment[] }> {
  const item = await apiGet<AlgoliaItem>(`${ITEM_URL}/${threadId}`)
  if (!item) throw new Error(`HN item ${threadId} not found`)
  const comments = (item.children ?? [])
    .filter((c) => typeof c.text === "string" && c.text.trim() !== "")
    .map((c) => ({
      id: c.id,
      author: c.author ?? null,
      created_at: c.created_at ?? null,
      text: c.text ?? null,
    }))
  return { title: item.title ?? `HN thread ${threadId}`, comments }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function cacheFile(): string {
  const env = (process.env.HN_CACHE_FILE ?? "").trim()
  if (env) return env
  return join(import.meta.dir, "..", ".cache.json")
}

interface CacheShape {
  latest?: { checked_at: string; id: string; title: string }
  threads: Record<string, { fetched_at: string; title: string; comments: HNComment[] }>
}

async function readCache(): Promise<CacheShape> {
  try {
    const file = Bun.file(cacheFile())
    if (await file.exists()) {
      const parsed = (await file.json()) as CacheShape
      if (parsed && typeof parsed.threads === "object") return parsed
    }
  } catch {
    // Unreadable cache: start fresh.
  }
  return { threads: {} }
}

async function writeCache(cache: CacheShape): Promise<void> {
  try {
    await Bun.write(cacheFile(), JSON.stringify(cache))
  } catch {
    // A read-only filesystem must not break the search.
  }
}

function isFresh(iso: string | undefined): boolean {
  if (!iso) return false
  const age = Date.now() - new Date(iso).getTime()
  return isFinite(age) && age >= 0 && age < CACHE_TTL_MS
}

/**
 * The comments of the requested thread (or the latest one), via the 6h cache.
 */
export async function loadThread(
  threadId: string | undefined,
): Promise<{ id: string; title: string; comments: HNComment[]; fromCache: boolean }> {
  const cache = await readCache()

  let id = threadId
  let titleHint: string | undefined
  if (!id) {
    if (cache.latest && isFresh(cache.latest.checked_at)) {
      id = cache.latest.id
      titleHint = cache.latest.title
    } else {
      const latest = await findLatestThread()
      id = latest.id
      titleHint = latest.title
      cache.latest = { checked_at: new Date().toISOString(), id, title: latest.title }
      await writeCache(cache)
    }
  }

  const entry = cache.threads[id]
  if (entry && isFresh(entry.fetched_at) && Array.isArray(entry.comments)) {
    return { id, title: entry.title, comments: entry.comments, fromCache: true }
  }

  const { title, comments } = await fetchThreadComments(id)
  cache.threads[id] = { fetched_at: new Date().toISOString(), title: titleHint ?? title, comments }
  // Keep the cache small: retain only the threads touched most recently.
  const ids = Object.keys(cache.threads)
  if (ids.length > 3) {
    ids
      .sort((a, b) => (cache.threads[a].fetched_at < cache.threads[b].fetched_at ? -1 : 1))
      .slice(0, ids.length - 3)
      .forEach((old) => delete cache.threads[old])
  }
  await writeCache(cache)
  return { id, title: titleHint ?? title, comments, fromCache: false }
}

// ---------------------------------------------------------------------------
// Comment parsing (best-effort header convention)
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
  author: string | null
}

export interface JobDetailResult extends JobResult {
  description: string | null
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

/** HN comment HTML -> readable text with paragraph breaks. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = html.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/?p[^>]*>/gi, "\n")
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

/** First line of the posting — the conventional "Company | Role | ..." header. */
export function headerLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? ""
}

const ROLE_RE =
  /engineer|developer|scientist|designer|architect|devops|sre\b|swe\b|full[\s-]?stack|front[\s-]?end|back[\s-]?end|mobile|founding|cto\b|lead\b|manager|intern(ship)?\b|programmer/i

const LOCATION_RE =
  /\b([A-Z][a-zA-Z.]+(?:\s[A-Z][a-zA-Z.]+)*,\s*(?:[A-Z]{2}|[A-Z][a-zA-Z]+))\b|new york|san francisco|\bnyc\b|\bsf\b|seattle|austin|boston|chicago|denver|los angeles|london|berlin|toronto|amsterdam|\busa?\b|\bus-based\b|united states|north america|\beu\b|europe|worldwide/i

export function parseRemoteType(header: string, fullText: string): string | null {
  const scan = (s: string): string | null => {
    const m = s.match(/\b(remote|hybrid|on[\s-]?site|in[\s-]?person)\b/i)
    if (!m) return null
    const w = m[1].toLowerCase().replace(/[\s-]/g, "")
    if (w === "remote") return "remote"
    if (w === "hybrid") return "hybrid"
    return "onsite"
  }
  return scan(header) ?? scan(fullText.slice(0, 400))
}

export function parseSalary(text: string): {
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
} {
  const none = { salary_min: null, salary_max: null, salary_currency: null }
  // "$150k-$200k", "$150K – $200K", "$150,000 - $200,000", and bare "150k-200k"
  // (headers often omit the $; the bare form is bounded to 30k–900k so counts
  // like "10k-50k users" never read as salary).
  const m =
    text.match(/\$\s?(\d{2,3})k\s*(?:-|–|—|to)\s*\$?\s?(\d{2,3})k/i) ??
    text.match(/\$\s?(\d{1,3}(?:,\d{3})+)\s*(?:-|–|—|to)\s*\$?\s?(\d{1,3}(?:,\d{3})+)/) ??
    text.match(/\b(\d{2,3})k\s*(?:-|–|—|to)\s*(\d{2,3})k\b/i)
  if (!m) return none
  const bare = !m[0].includes("$")
  const expand = (s: string) =>
    s.includes(",") ? parseInt(s.replace(/,/g, ""), 10) : parseInt(s, 10) * 1000
  const min = expand(m[1])
  const max = expand(m[2])
  if (!isFinite(min) || !isFinite(max) || min < 10000 || max < min) return none
  if (bare && (min < 30000 || max > 900000)) return none
  return { salary_min: min, salary_max: max, salary_currency: "USD" }
}

/**
 * Best-effort parse of one top-level comment into the portal contract.
 * Convention: "Company | Role | Location | Salary | REMOTE" — but every field
 * beyond the company is optional and the order varies.
 */
export function parseComment(c: HNComment): JobDetailResult {
  const text = htmlToText(c.text) ?? ""
  const header = headerLine(text)

  // Segments: split on pipes; a pipe-less header falls back to " - " dashes.
  let segments = header.split("|").map((s) => s.trim()).filter(Boolean)
  if (segments.length === 1) {
    segments = header.split(/\s[-–—]\s/).map((s) => s.trim()).filter(Boolean)
  }

  const company = segments[0]?.slice(0, 80) || null

  let role: string | null = null
  let location: string | null = null
  for (const seg of segments.slice(1)) {
    if (!role && ROLE_RE.test(seg) && !/^remote$/i.test(seg)) {
      role = seg
      continue
    }
    if (!location && LOCATION_RE.test(seg) && !/^\$/.test(seg)) {
      location = seg
    }
  }

  const remote_type = parseRemoteType(header, text)
  const salary = parseSalary(header) ?? parseSalary(text)
  const effectiveSalary = salary.salary_min !== null ? salary : parseSalary(text)

  return {
    id: String(c.id),
    title: role ?? (header ? header.slice(0, 100) : "(untitled posting)"),
    company,
    location,
    date: c.created_at ? c.created_at.slice(0, 10) : null,
    url: `https://news.ycombinator.com/item?id=${c.id}`,
    remote_type,
    ...effectiveSalary,
    author: c.author,
    description: text || null,
  }
}
