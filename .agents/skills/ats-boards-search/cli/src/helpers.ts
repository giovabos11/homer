// Data source: per-company public ATS JSON endpoints — Greenhouse, Lever, and
// Ashby job boards. All three are official, unauthenticated APIs published for
// exactly this purpose (embedding a company's job board on its own site), so
// there is no HTML scraping and no ToS risk. The swept company registry lives
// in ../../companies.json (override with ATS_COMPANIES_FILE for tests).

import { join } from "path"

export const GREENHOUSE_BASE = "https://boards-api.greenhouse.io/v1/boards"
export const LEVER_BASE = "https://api.lever.co/v0/postings"
export const ASHBY_BASE = "https://api.ashbyhq.com/posting-api/job-board"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "ats-boards-search-skill/1.0 (personal job search)"

// Global politeness budget: at most ~2 request starts per second across the
// whole sweep, enforced by spacing sequential requests. The sweep is strictly
// sequential (one company at a time), so this is a hard global cap.
const MIN_REQUEST_SPACING_MS = 500
let lastRequestAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function politePause(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/**
 * GET a JSON endpoint with the global politeness spacing and exponential
 * backoff on 429/5xx. Returns null on 404 (board does not exist).
 */
export async function apiGet<T>(url: string): Promise<T | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await politePause()
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`ATS request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`ATS request failed: ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
  }
  throw new Error("ATS request failed after max retries")
}

// ---------------------------------------------------------------------------
// Company registry
// ---------------------------------------------------------------------------

export type AtsKind = "greenhouse" | "lever" | "ashby"

export const ATS_KINDS: AtsKind[] = ["greenhouse", "lever", "ashby"]

export interface Company {
  slug: string
  ats: AtsKind
  name: string
  /** true when the slug has not been checked live against the ATS API. */
  unverified?: boolean
}

/** Path to companies.json: ATS_COMPANIES_FILE override, or the skill root copy. */
export function companiesFile(): string {
  const env = (process.env.ATS_COMPANIES_FILE ?? "").trim()
  if (env) return env
  return join(import.meta.dir, "..", "..", "companies.json")
}

export async function loadCompanies(): Promise<Company[]> {
  const path = companiesFile()
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`company registry not found at ${path}`)
  }
  const data = (await file.json().catch(() => null)) as Company[] | null
  if (!Array.isArray(data)) {
    throw new Error(`company registry at ${path} is not a JSON array`)
  }
  return data.filter(
    (c): c is Company =>
      !!c && typeof c.slug === "string" && ATS_KINDS.includes(c.ats as AtsKind),
  )
}

// ---------------------------------------------------------------------------
// Portal-contract result shapes
// ---------------------------------------------------------------------------

export interface JobResult {
  id: string // "<ats>:<company-slug>:<job-id>" — what `detail` consumes
  title: string
  company: string | null
  location: string | null
  date: string | null // YYYY-MM-DD posting date
  url: string
  remote_type: string | null // remote | hybrid | onsite | null
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
}

export interface JobDetailResult extends JobResult {
  employment_type: string | null
  description: string | null
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeHtmlEntities(text: string): string {
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

/**
 * Strip HTML into readable prose: block/line-break tags become newlines,
 * entities are decoded, remaining tags removed. Null for empty input.
 */
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

/** Classify a location string as remote/hybrid, or null when it says neither. */
export function remoteFromLocation(location: string | null): string | null {
  if (!location) return null
  if (/\bremote\b/i.test(location)) return "remote"
  if (/\bhybrid\b/i.test(location)) return "hybrid"
  return null
}

/** The YYYY-MM-DD date portion of an ISO timestamp string, or null. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** YYYY-MM-DD from a millisecond epoch, or null. */
export function epochDate(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Greenhouse mapping
// ---------------------------------------------------------------------------

export interface GreenhousePayRange {
  min_cents?: number
  max_cents?: number
  currency_type?: string
  title?: string
}

export interface GreenhouseJob {
  id: number
  title: string
  location?: { name?: string }
  absolute_url: string
  updated_at?: string
  first_published?: string
  company_name?: string
  content?: string // HTML-entity-escaped HTML
  pay_input_ranges?: GreenhousePayRange[]
  metadata?: unknown
}

export function mapGreenhouseJob(company: Company, j: GreenhouseJob): JobResult {
  const location = j.location?.name ?? null
  const salary = greenhouseSalary(j.pay_input_ranges)
  return {
    id: `greenhouse:${company.slug}:${j.id}`,
    title: j.title ?? "(untitled)",
    company: company.name || j.company_name || null,
    location,
    date: isoDate(j.first_published) ?? isoDate(j.updated_at),
    url: j.absolute_url || `https://boards.greenhouse.io/${company.slug}/jobs/${j.id}`,
    remote_type: remoteFromLocation(location),
    ...salary,
  }
}

export function greenhouseSalary(ranges: GreenhousePayRange[] | undefined): {
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
} {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return { salary_min: null, salary_max: null, salary_currency: null }
  }
  // Prefer a USD range when several jurisdictions are listed.
  const usd = ranges.find((r) => (r.currency_type ?? "").toUpperCase() === "USD")
  const r = usd ?? ranges[0]
  const min = typeof r.min_cents === "number" ? Math.round(r.min_cents / 100) : null
  const max = typeof r.max_cents === "number" ? Math.round(r.max_cents / 100) : null
  if (min === null && max === null) {
    return { salary_min: null, salary_max: null, salary_currency: null }
  }
  return { salary_min: min, salary_max: max, salary_currency: r.currency_type ?? null }
}

// ---------------------------------------------------------------------------
// Lever mapping
// ---------------------------------------------------------------------------

export interface LeverPosting {
  id: string
  text: string
  categories?: {
    location?: string
    allLocations?: string[]
    team?: string
    commitment?: string
  }
  workplaceType?: string // "remote" | "hybrid" | "on-site" | "onsite" | "unspecified"
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string }
  createdAt?: number // epoch ms
  hostedUrl?: string
  country?: string
  descriptionPlain?: string
  additionalPlain?: string
  openingPlain?: string
}

export function leverRemoteType(p: LeverPosting): string | null {
  const wt = (p.workplaceType ?? "").toLowerCase()
  if (wt === "remote") return "remote"
  if (wt === "hybrid") return "hybrid"
  if (wt === "on-site" || wt === "onsite") return "onsite"
  return remoteFromLocation(p.categories?.location ?? null)
}

export function mapLeverJob(company: Company, p: LeverPosting): JobResult {
  const location = p.categories?.location ?? p.categories?.allLocations?.[0] ?? null
  const sr = p.salaryRange
  return {
    id: `lever:${company.slug}:${p.id}`,
    title: p.text ?? "(untitled)",
    company: company.name || null,
    location,
    date: epochDate(p.createdAt),
    url: p.hostedUrl || `https://jobs.lever.co/${company.slug}/${p.id}`,
    remote_type: leverRemoteType(p),
    salary_min: typeof sr?.min === "number" ? sr.min : null,
    salary_max: typeof sr?.max === "number" ? sr.max : null,
    salary_currency: sr && (sr.min != null || sr.max != null) ? (sr.currency ?? null) : null,
  }
}

// ---------------------------------------------------------------------------
// Ashby mapping
// ---------------------------------------------------------------------------

export interface AshbyCompensationComponent {
  compensationType?: string // "Salary" | "EquityCashValue" | ...
  interval?: string
  currencyCode?: string
  minValue?: number | null
  maxValue?: number | null
}

export interface AshbyJob {
  id: string
  title: string
  location?: string
  secondaryLocations?: Array<{ location?: string }>
  employmentType?: string
  publishedAt?: string
  isListed?: boolean
  isRemote?: boolean | null
  workplaceType?: string // "Remote" | "Hybrid" | "Onsite"
  jobUrl?: string
  applyUrl?: string
  descriptionHtml?: string
  descriptionPlain?: string
  compensation?: { summaryComponents?: AshbyCompensationComponent[] }
}

export function ashbyRemoteType(j: AshbyJob): string | null {
  const wt = (j.workplaceType ?? "").toLowerCase()
  if (wt === "remote") return "remote"
  if (wt === "hybrid") return "hybrid"
  if (wt === "onsite" || wt === "on-site") return "onsite"
  if (j.isRemote === true) return "remote"
  return remoteFromLocation(j.location ?? null)
}

export function ashbySalary(j: AshbyJob): {
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
} {
  const comps = j.compensation?.summaryComponents
  const salary = Array.isArray(comps)
    ? comps.find((c) => (c.compensationType ?? "").toLowerCase() === "salary")
    : undefined
  if (!salary || (salary.minValue == null && salary.maxValue == null)) {
    return { salary_min: null, salary_max: null, salary_currency: null }
  }
  return {
    salary_min: salary.minValue ?? null,
    salary_max: salary.maxValue ?? null,
    salary_currency: salary.currencyCode ?? null,
  }
}

export function mapAshbyJob(company: Company, j: AshbyJob): JobResult {
  return {
    id: `ashby:${company.slug}:${j.id}`,
    title: j.title ?? "(untitled)",
    company: company.name || null,
    location: j.location ?? null,
    date: isoDate(j.publishedAt),
    url: j.jobUrl || `https://jobs.ashbyhq.com/${company.slug}/${j.id}`,
    remote_type: ashbyRemoteType(j),
    ...ashbySalary(j),
  }
}

// ---------------------------------------------------------------------------
// Job references ("<ats>:<slug>:<jobid>" or a board URL)
// ---------------------------------------------------------------------------

export interface JobRef {
  ats: AtsKind
  slug: string
  jobId: string
}

export function parseJobRef(input: string): JobRef | null {
  const t = input.trim()
  let m = t.match(/^(greenhouse|lever|ashby):([^:\s]+):(.+)$/i)
  if (m) return { ats: m[1].toLowerCase() as AtsKind, slug: m[2], jobId: m[3] }
  m = t.match(/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_app\?[^ ]*token=)?([^/?#]+)\/jobs\/(\d+)/i)
  if (m) return { ats: "greenhouse", slug: m[1], jobId: m[2] }
  m = t.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)\/jobs\/(\d+)/i)
  if (m) return { ats: "greenhouse", slug: m[1], jobId: m[2] }
  m = t.match(/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)\/([0-9a-fA-F-]{36})/i)
  if (m) return { ats: "lever", slug: m[1], jobId: m[2] }
  m = t.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-fA-F-]{36})/i)
  if (m) return { ats: "ashby", slug: m[1], jobId: m[2] }
  return null
}
