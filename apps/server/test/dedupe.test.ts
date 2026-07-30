import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dedupeKey, normalizeCompany, locationBucket, parseSalary, upsertJob } from '../src/sources/dedupe';
import { makeWorld, type TestWorld } from './helpers';

describe('dedupe key normalization', () => {
  it('normalizes company suffixes, case and punctuation', () => {
    expect(normalizeCompany('Acme, Inc.')).toBe('acme');
    expect(normalizeCompany('ACME LLC')).toBe('acme');
    expect(normalizeCompany('Acme  Corporation')).toBe('acme');
  });

  it('buckets remote roles together and onsite by first locality segment', () => {
    expect(locationBucket('Anywhere (US)', 'remote')).toBe('remote');
    expect(locationBucket(null, 'remote')).toBe('remote');
    expect(locationBucket('Dallas, TX, USA', 'onsite')).toBe('dallas');
    expect(locationBucket('Dallas', 'hybrid')).toBe('dallas');
    expect(locationBucket(null, 'onsite')).toBe('unknown');
  });

  it('produces equal keys for equivalent postings', () => {
    const a = dedupeKey('Acme, Inc.', 'Senior Software Engineer', 'Dallas, TX', 'onsite');
    const b = dedupeKey('acme', 'Senior Software Engineer!', 'Dallas', 'onsite');
    expect(a).toBe(b);
  });

  it('parses salary strings', () => {
    expect(parseSalary('$120k - $150k')).toEqual({ min: 120000, max: 150000, currency: 'USD' });
    expect(parseSalary('100,000 - 130,000 USD')).toEqual({ min: 100000, max: 130000, currency: 'USD' });
    expect(parseSalary(null)).toEqual({ min: null, max: null, currency: null });
  });
});

describe('upsert into jobs', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => world.cleanup());

  const base = {
    source: 'linkedin',
    externalId: 'x1',
    canonicalUrl: 'https://linkedin.example/x1',
    company: 'Acme, Inc.',
    title: 'Software Engineer',
    location: 'Dallas, TX',
    remoteType: 'onsite' as const,
    descriptionMd: null as string | null,
  };

  it('inserts once, then dedupes equivalent sightings', () => {
    const first = upsertJob(world.ctx.db, base);
    expect(first.inserted).toBe(true);
    const second = upsertJob(world.ctx.db, { ...base, company: 'ACME', location: 'Dallas', externalId: 'x2' });
    expect(second.inserted).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it('enriches missing fields without regressing existing data', () => {
    const first = upsertJob(world.ctx.db, base);
    const second = upsertJob(world.ctx.db, {
      ...base,
      descriptionMd: 'Full JD text',
      salaryMin: 100000,
      salaryMax: 130000,
      salaryCurrency: 'USD',
    });
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.descriptionMd).toBe('Full JD text');
    expect(second.job.salaryMax).toBe(130000);
    // Status untouched by re-sighting.
    expect(second.job.status).toBe('discovered');
  });

  it('prefers ATS records over aggregator sightings', () => {
    upsertJob(world.ctx.db, { ...base, descriptionMd: 'linkedin snippet' });
    const ats = upsertJob(world.ctx.db, {
      ...base,
      source: 'greenhouse',
      externalId: 'gh-1',
      canonicalUrl: 'https://boards.greenhouse.io/acme/1',
      descriptionMd: 'Structured ATS description',
    });
    expect(ats.inserted).toBe(false);
    expect(ats.job.source).toBe('greenhouse');
    expect(ats.job.canonicalUrl).toBe('https://boards.greenhouse.io/acme/1');
    expect(ats.job.descriptionMd).toBe('Structured ATS description');

    // Later aggregator sighting must NOT take the identity back.
    const again = upsertJob(world.ctx.db, { ...base, descriptionMd: 'linkedin snippet again' });
    expect(again.job.source).toBe('greenhouse');
    expect(again.job.descriptionMd).toBe('Structured ATS description');
  });
});
