// Dedupe + upsert (FR-1/FR-8): jobs are keyed by a normalized
// company+title+location bucket. ATS records are preferred over aggregator
// sightings; upserts enrich missing fields and never regress pipeline status.
import { eq } from 'drizzle-orm';
import type { RemoteType } from '@shared/types';
import type { Db } from '../db/client';
import { jobs } from '../db/schema';
import type { PortalHit } from './portal-cli';

type JobRow = typeof jobs.$inferSelect;

/** Sources whose records are authoritative (structured ATS data). */
const ATS_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'ats_boards', 'usajobs']);

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|aps|a\/s)\b\.?/g;

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompany(company: string): string {
  return normalizeText(company).replace(COMPANY_SUFFIXES, '').replace(/\s+/g, ' ').trim();
}

/** Coarse location bucket: remote roles collide regardless of phrasing; onsite buckets by first locality segment. */
export function locationBucket(location: string | null, remoteType: RemoteType): string {
  if (remoteType === 'remote') return 'remote';
  if (!location) return 'unknown';
  const first = location.split(/[,;|/]/)[0] ?? location;
  const norm = normalizeText(first);
  return norm || 'unknown';
}

export function dedupeKey(company: string, title: string, location: string | null, remoteType: RemoteType): string {
  return [normalizeCompany(company), normalizeText(title), locationBucket(location, remoteType)].join('|');
}

export function inferRemoteType(workMode: string | null, location: string | null): RemoteType {
  const mode = (workMode ?? '').toLowerCase();
  if (mode.includes('remote')) return 'remote';
  if (mode.includes('hybrid')) return 'hybrid';
  if (mode.includes('onsite') || mode.includes('on-site') || mode.includes('office')) return 'onsite';
  const loc = (location ?? '').toLowerCase();
  if (loc.includes('remote')) return 'remote';
  if (loc.includes('hybrid')) return 'hybrid';
  return location ? 'onsite' : 'unknown';
}

/** Best-effort "$120k–$150k" / "100,000 - 130,000 USD" parser. */
export function parseSalary(text: string | null): { min: number | null; max: number | null; currency: string | null } {
  if (!text) return { min: null, max: null, currency: null };
  const currency = /usd|\$/i.test(text) ? 'USD' : /eur|€/i.test(text) ? 'EUR' : /dkk/i.test(text) ? 'DKK' : null;
  const nums = [...text.matchAll(/(\d[\d,.]*)\s*(k)?/gi)]
    .map((m) => {
      let n = Number.parseFloat(m[1]!.replace(/,/g, ''));
      if (m[2]) n *= 1000;
      return n;
    })
    .filter((n) => Number.isFinite(n) && n >= 1000);
  if (nums.length === 0) return { min: null, max: null, currency };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { min, max: max > min ? max : min, currency: currency ?? 'USD' };
}

export interface UpsertResult {
  job: JobRow;
  inserted: boolean;
}

export interface JobInput {
  source: string;
  externalId: string | null;
  canonicalUrl: string;
  company: string;
  title: string;
  location: string | null;
  remoteType: RemoteType;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  salaryPredicted?: boolean;
  descriptionMd?: string | null;
  postedAt?: string | null;
  raw?: unknown;
  managed?: 'auto' | 'manual';
  status?: string;
}

export function upsertJob(db: Db, input: JobInput, now: Date = new Date()): UpsertResult {
  const key = dedupeKey(input.company, input.title, input.location, input.remoteType);
  const existing = db.select().from(jobs).where(eq(jobs.dedupeKey, key)).get();

  if (!existing) {
    const row = db
      .insert(jobs)
      .values({
        source: input.source,
        externalId: input.externalId,
        canonicalUrl: input.canonicalUrl,
        company: input.company,
        title: input.title,
        location: input.location,
        remoteType: input.remoteType,
        salaryMin: input.salaryMin ?? null,
        salaryMax: input.salaryMax ?? null,
        salaryCurrency: input.salaryCurrency ?? null,
        salaryPredicted: input.salaryPredicted ? 1 : 0,
        descriptionMd: input.descriptionMd ?? null,
        rawJson: input.raw != null ? JSON.stringify(input.raw) : null,
        postedAt: input.postedAt ?? null,
        firstSeen: now.toISOString(),
        status: input.status ?? 'discovered',
        managed: input.managed ?? 'auto',
        dedupeKey: key,
      })
      .returning()
      .get();
    return { job: row, inserted: true };
  }

  // Enrich, never regress: fill missing fields; ATS sighting replaces aggregator identity.
  const newIsAts = ATS_SOURCES.has(input.source);
  const existingIsAts = ATS_SOURCES.has(existing.source);
  const preferNew = newIsAts && !existingIsAts;

  const updated = db
    .update(jobs)
    .set({
      source: preferNew ? input.source : existing.source,
      externalId: preferNew ? input.externalId : (existing.externalId ?? input.externalId),
      canonicalUrl: preferNew && input.canonicalUrl ? input.canonicalUrl : existing.canonicalUrl || input.canonicalUrl,
      location: existing.location ?? input.location,
      remoteType: existing.remoteType === 'unknown' ? input.remoteType : existing.remoteType,
      salaryMin: existing.salaryMin ?? input.salaryMin ?? null,
      salaryMax: existing.salaryMax ?? input.salaryMax ?? null,
      salaryCurrency: existing.salaryCurrency ?? input.salaryCurrency ?? null,
      descriptionMd:
        preferNew && input.descriptionMd
          ? input.descriptionMd
          : (existing.descriptionMd ?? input.descriptionMd ?? null),
      postedAt: existing.postedAt ?? input.postedAt ?? null,
      rawJson: input.raw != null ? JSON.stringify(input.raw) : existing.rawJson,
    })
    .where(eq(jobs.id, existing.id))
    .returning()
    .get();
  return { job: updated, inserted: false };
}

/** Map a portal hit to a JobInput ready for upsert. */
export function hitToJobInput(source: string, hit: PortalHit): JobInput {
  const remoteType = inferRemoteType(hit.workMode, hit.location);
  const salary = parseSalary(hit.salary);
  return {
    source,
    externalId: hit.id,
    canonicalUrl: hit.url,
    company: hit.company ?? 'Unknown company',
    title: hit.title,
    location: hit.location,
    remoteType,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    descriptionMd: hit.description,
    postedAt: hit.date,
    raw: hit.raw,
  };
}
