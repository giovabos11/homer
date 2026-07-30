// Data source: We Work Remotely public RSS feeds. Each category has an RSS
// feed (plus an all-jobs feed); items carry "Company: Title" titles, a region,
// a category, and the full job description as encoded HTML. Parsed with a
// light regex pass (the markup is flat and stable), the same approach the
// upstream portals use for HTML.

import { join } from "path"

export const BASE_URL = "https://weworkremotely.com"

/** Category slug -> feed URL. */
export const FEEDS: Record<string, string> = {
  programming: `${BASE_URL}/categories/remote-programming-jobs.rss`,
  "full-stack": `${BASE_URL}/categories/remote-full-stack-programming-jobs.rss`,
  "front-end": `${BASE_URL}/categories/remote-front-end-programming-jobs.rss`,
  "back-end": `${BASE_URL}/categories/remote-back-end-programming-jobs.rss`,
  devops: `${BASE_URL}/categories/remote-devops-sysadmin-jobs.rss`,
  all: `${BASE_URL}/remote-jobs.rss`,
}

export const DEFAULT_CATEGORY = "programming"

const CACHE_TTL_MS = 60 * 60 * 1000 // 1h — enough to serve search→detail without refetching

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "weworkremotely-search-skill/1.0 (personal job search)"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** GET a feed with exponential backoff on 429/5xx. */
export async function fetchFeed(url: string): Promise<string> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`WWR request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (!response.ok) {
      throw new Error(`WWR request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("WWR request failed after max retries")
}

// ---------------------------------------------------------------------------
// Cache (per category, 1h TTL)
// ---------------------------------------------------------------------------

export function cacheFile(): string {
  const env = (process.env.WWR_CACHE_FILE ?? "").trim()
  if (env) return env
  return join(import.meta.dir, "..", ".cache.json")
}

interface CacheShape {
  categories: Record<string, { fetched_at: string; items: FeedItem[] }>
}

export async function loadCategory(category: string): Promise<{ items: FeedItem[]; fromCache: boolean }> {
  const feedUrl = FEEDS[category]
  if (!feedUrl) {
    throw new Error(`unknown category "${category}" — expected one of: ${Object.keys(FEEDS).join(", ")}`)
  }

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
  if (entry && Array.isArray(entry.items)) {
    const age = Date.now() - new Date(entry.fetched_at).getTime()
    if (isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
      return { items: entry.items, fromCache: true }
    }
  }

  const xml = await fetchFeed(feedUrl)
  const items = parseFeed(xml)
  cache.categories[category] = { fetched_at: new Date().toISOString(), items }
  try {
    await Bun.write(path, JSON.stringify(cache))
  } catch {
    // A read-only filesystem must not break the search.
  }
  return { items, fromCache: false }
}

// ---------------------------------------------------------------------------
// RSS parsing (regex — the markup is flat)
// ---------------------------------------------------------------------------

export interface FeedItem {
  id: string // slug from the item link
  company: string | null
  title: string
  region: string | null
  category: string | null
  date: string | null // YYYY-MM-DD from pubDate
  url: string
  descriptionHtml: string | null
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeXmlEntities(text: string): string {
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

/** The text content of the first <tag> in the chunk, CDATA- and entity-aware. */
export function extractTag(chunk: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")
  const m = re.exec(chunk)
  if (!m) return null
  let inner = m[1].trim()
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  if (cdata) return cdata[1].trim()
  return decodeXmlEntities(inner).trim()
}

/** "Company: Job Title" -> { company, title }. No colon means no company. */
export function splitTitle(raw: string): { company: string | null; title: string } {
  const idx = raw.indexOf(": ")
  if (idx <= 0) return { company: null, title: raw.trim() }
  return { company: raw.slice(0, idx).trim() || null, title: raw.slice(idx + 2).trim() }
}

/** RFC-2822 pubDate -> YYYY-MM-DD, or null. */
export function pubDateToIso(raw: string | null): string | null {
  if (!raw) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** The job slug from a weworkremotely listing URL. */
export function slugFromUrl(url: string): string | null {
  const m = url.match(/\/(?:remote-jobs|listings)\/([^/?#]+)/i)
  return m ? m[1] : null
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  const chunks = xml.split(/<item>/i).slice(1)
  for (const rawChunk of chunks) {
    const chunk = rawChunk.split(/<\/item>/i)[0]
    const titleRaw = extractTag(chunk, "title")
    if (!titleRaw) continue
    const link = extractTag(chunk, "link") ?? extractTag(chunk, "guid")
    if (!link) continue
    const { company, title } = splitTitle(titleRaw)
    const slug = slugFromUrl(link)
    items.push({
      id: slug ?? link,
      company,
      title,
      region: extractTag(chunk, "region"),
      category: extractTag(chunk, "category"),
      date: pubDateToIso(extractTag(chunk, "pubDate")),
      url: link,
      // Keep the description as HTML in the cache; converted to text on detail.
      descriptionHtml: extractTag(chunk, "description"),
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// Portal-contract result shapes
// ---------------------------------------------------------------------------

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null // the feed's region
  date: string | null
  url: string
  remote_type: string | null
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  category: string | null
}

export interface JobDetailResult extends JobResult {
  description: string | null
}

export function toResult(item: FeedItem): JobResult {
  const salary = parseSalaryFromText(item.descriptionHtml ?? "")
  return {
    id: item.id,
    title: item.title,
    company: item.company,
    location: item.region,
    date: item.date,
    url: item.url,
    remote_type: "remote", // the whole board is remote-only
    ...salary,
    category: item.category,
  }
}

export function toDetail(item: FeedItem): JobDetailResult {
  return { ...toResult(item), description: htmlToText(item.descriptionHtml) }
}

/**
 * Conservative salary sniff from description text: only an explicit dollar
 * range of annual-sized amounts ("$120,000 - $150,000", "$120k–$150k")
 * produces numbers; anything else stays null.
 */
export function parseSalaryFromText(text: string): {
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
} {
  const none = { salary_min: null, salary_max: null, salary_currency: null }
  if (!text) return none
  const m = text.match(
    /\$\s?(\d{1,3}(?:,\d{3})+|\d{2,3}k)\s*(?:-|–|—|to)\s*\$?\s?(\d{1,3}(?:,\d{3})+|\d{2,3}k)/i,
  )
  if (!m) return none
  const expand = (s: string) =>
    /k$/i.test(s) ? parseInt(s, 10) * 1000 : parseInt(s.replace(/,/g, ""), 10)
  const min = expand(m[1])
  const max = expand(m[2])
  if (!isFinite(min) || !isFinite(max) || min < 10000 || max < min) return none
  return { salary_min: min, salary_max: max, salary_currency: "USD" }
}

export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr|table)>/gi, "\n")
  const text = decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

/** Every query word must appear in title/company/category/description. */
export function itemMatchesQuery(item: FeedItem, query: string): boolean {
  const haystack = [item.title, item.company, item.category, item.descriptionHtml]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => haystack.includes(w))
}
