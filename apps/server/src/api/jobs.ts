// Jobs routes (contract §Jobs — FR-4, FR-5, FR-17, FR-19).
import { Router } from 'express';
import { and, desc, asc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { jobs } from '../db/schema';
import { toJob } from '../db/serialize';
import { dedupeKey, upsertJob } from '../sources/dedupe';
import { fetchJobDetailFromPortal, fetchJobDetailViaAgent } from '../sources/enrich';
import { PRIORITY } from '../queue/queue';
import type { AppContext } from '../context';
import { ApiError, idParam, parseBody, parseQuery } from './util';

const listQuerySchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  source: z.string().optional(),
  remote: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  legit: z.enum(['legit', 'suspicious', 'scam', 'unchecked']).optional(),
  sort: z.enum(['salary', 'score', 'date']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Salary midpoint: (min+max)/2, or whichever single bound exists. */
export function salaryMid(job: { salaryMin: number | null; salaryMax: number | null }): number | null {
  if (job.salaryMin != null && job.salaryMax != null) return (job.salaryMin + job.salaryMax) / 2;
  return job.salaryMax ?? job.salaryMin;
}

/**
 * Expected-value rank (FR-17): salaryMid × (fitScore/100)^1.5, discounted
 * ×0.85 for predicted (not posted) salaries. Null when the job is unscored
 * or has no salary — unscored jobs rank below every scored one.
 */
export function opportunityScore(job: {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPredicted: number | boolean;
  fitScore: number | null;
}): number | null {
  const mid = salaryMid(job);
  if (mid == null || job.fitScore == null) return null;
  const predicted = typeof job.salaryPredicted === 'number' ? job.salaryPredicted === 1 : job.salaryPredicted;
  const ev = mid * Math.pow(Math.max(0, Math.min(100, job.fitScore)) / 100, 1.5);
  return Math.round(ev * (predicted ? 0.85 : 1));
}

const createJobSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  canonicalUrl: z.string().default(''),
  location: z.string().nullish(),
  remoteType: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).default('unknown'),
  salaryMin: z.number().nullish(),
  salaryMax: z.number().nullish(),
  salaryCurrency: z.string().nullish(),
  descriptionMd: z.string().nullish(),
  status: z
    .enum([
      'discovered', 'screened', 'tailoring', 'ready_for_review', 'applied', 'interview',
      'offer', 'hired', 'rejected', 'no_response', 'withdrawn', 'quarantined', 'skipped',
    ])
    .default('discovered'),
  source: z.string().default('manual'),
  postedAt: z.string().nullish(),
  notes: z.string().nullish(),
});

export function jobRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/jobs', (req, res) => {
    const q = parseQuery(listQuerySchema, req);
    const filters: SQL[] = [];
    if (q.q) {
      const term = `%${q.q}%`;
      filters.push(or(like(jobs.company, term), like(jobs.title, term), like(jobs.descriptionMd, term))!);
    }
    if (q.status) filters.push(eq(jobs.status, q.status));
    if (q.source) filters.push(eq(jobs.source, q.source));
    if (q.remote) filters.push(eq(jobs.remoteType, q.remote));
    if (q.minScore != null) filters.push(sql`${jobs.fitScore} >= ${q.minScore}`);
    if (q.legit) filters.push(eq(jobs.legitVerdict, q.legit));
    const where = filters.length > 0 ? and(...filters) : undefined;

    const sortCol =
      q.sort === 'salary' ? sql`COALESCE(${jobs.salaryMax}, ${jobs.salaryMin}, 0)`
      : q.sort === 'score' ? sql`COALESCE(${jobs.fitScore}, -1)`
      : jobs.firstSeen;
    const orderBy = (q.order ?? 'desc') === 'asc' ? asc(sortCol as never) : desc(sortCol as never);

    const total = ctx.db.select({ n: sql<number>`count(*)` }).from(jobs).where(where).get()?.n ?? 0;
    const rows = ctx.db.select().from(jobs).where(where).orderBy(orderBy).limit(q.limit).offset(q.offset).all();
    res.json({ total, jobs: rows.map(toJob) });
  });

  // FR-17: top opportunities. Default ranking is expected value — salary
  // weighted by the realistic chance of getting the job:
  //   opportunityScore = salaryMid × (fitScore/100)^1.5   (×0.85 when the
  //   salary is predicted, not posted). salaryMid = (min+max)/2 or the single
  //   bound. Unscored jobs rank below every scored job (salary desc among
  //   themselves). by=salary keeps the raw ranking (fitWeighted supported).
  router.get('/jobs/top', (req, res) => {
    const q = parseQuery(
      z.object({
        by: z.enum(['opportunity', 'salary']).default('opportunity'),
        fitWeighted: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      }),
      req,
    );
    const rows = ctx.db
      .select()
      .from(jobs)
      .where(
        sql`COALESCE(${jobs.salaryMax}, ${jobs.salaryMin}) IS NOT NULL
            AND ${jobs.status} NOT IN ('quarantined','skipped','rejected')
            AND ${jobs.legitVerdict} NOT IN ('suspicious','scam')`,
      )
      .all();

    const withEv = rows.map((row) => ({ row, ev: opportunityScore(row) }));
    if (q.by === 'opportunity') {
      withEv.sort((a, b) => {
        if (a.ev != null && b.ev != null) return b.ev - a.ev;
        if (a.ev != null) return -1; // scored jobs above all unscored
        if (b.ev != null) return 1;
        return salaryMid(b.row)! - salaryMid(a.row)!; // unscored fallback: salary desc
      });
    } else {
      const rank = (r: (typeof rows)[number]) => {
        const salary = r.salaryMax ?? r.salaryMin ?? 0;
        return q.fitWeighted === 'true' ? salary * ((r.fitScore ?? 50) / 100) : salary;
      };
      withEv.sort((a, b) => rank(b.row) - rank(a.row));
    }
    res.json(withEv.slice(0, q.limit).map(({ row, ev }) => ({ ...toJob(row), opportunityScore: ev })));
  });

  router.get('/jobs/:id', (req, res) => {
    const row = ctx.db.select().from(jobs).where(eq(jobs.id, idParam(req))).get();
    if (!row) throw new ApiError(404, 'not_found', `No job ${req.params.id}`);
    res.json(toJob(row));
  });

  // FR-5: manual job/application record — automation tracks but never acts on it.
  router.post('/jobs', (req, res) => {
    const body = parseBody(createJobSchema, req);
    const now = new Date();
    const row = ctx.db
      .insert(jobs)
      .values({
        source: body.source,
        externalId: null,
        canonicalUrl: body.canonicalUrl,
        company: body.company,
        title: body.title,
        location: body.location ?? null,
        remoteType: body.remoteType,
        salaryMin: body.salaryMin ?? null,
        salaryMax: body.salaryMax ?? null,
        salaryCurrency: body.salaryCurrency ?? null,
        descriptionMd: body.descriptionMd ?? null,
        postedAt: body.postedAt ?? null,
        firstSeen: now.toISOString(),
        status: body.status,
        managed: 'manual',
        dedupeKey: `manual|${dedupeKey(body.company, body.title, body.location ?? null, body.remoteType)}|${now.getTime()}`,
      })
      .returning()
      .get();
    const job = toJob(row);
    ctx.bus.emit({ type: 'job.discovered', job });
    res.status(201).json(job);
  });

  // FR-4: paste-a-URL auto-apply — parse (untrusted input), save, score, enter the pipeline.
  router.post('/jobs/from-url', (req, res) => {
    const body = parseBody(z.object({ url: z.string().url() }), req);
    const url = new URL(body.url);
    const { job } = upsertJob(ctx.db, {
      source: 'url',
      externalId: null,
      canonicalUrl: body.url,
      company: url.hostname.replace(/^www\./, ''),
      title: `Posting from ${url.hostname}`,
      location: null,
      remoteType: 'unknown',
      descriptionMd: null,
      raw: { pastedUrl: body.url },
    });
    ctx.bus.emit({ type: 'job.discovered', job: toJob(job) });
    // The score worker (pipeline phase: fetch + parse first) picks it up from
    // here — user-initiated, so it jumps the bulk-scoring backlog.
    const task = ctx.queue.enqueue('score', { priority: PRIORITY.user, payload: { jobId: job.id, fetchUrl: body.url } });
    res.status(201).json({ job: toJob(job), taskId: task.id, queuePosition: ctx.queue.positionOf(task.id) });
  });

  router.post('/jobs/:id/apply', (req, res) => {
    const id = idParam(req);
    const row = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw new ApiError(404, 'not_found', `No job ${id}`);
    if (row.legitVerdict === 'scam') {
      throw new ApiError(409, 'quarantined', 'This job is quarantined as a scam and cannot enter the apply pipeline');
    }
    // User-clicked → priority 10: claims ahead of the bulk score backlog.
    const task = ctx.queue.enqueue('tailor', { priority: PRIORITY.user, payload: { jobId: id } });
    res.json({ taskId: task.id, queuePosition: ctx.queue.positionOf(task.id) });
  });

  // On-demand description backfill: portal `detail` first, then an agent
  // (haiku + WebFetch) extraction of the canonical URL as untrusted data.
  router.post('/jobs/:id/fetch-details', async (req, res) => {
    const id = idParam(req);
    let row = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!row) throw new ApiError(404, 'not_found', `No job ${id}`);

    if (!row.descriptionMd) {
      row = (await fetchJobDetailFromPortal(ctx, row)) ?? row;
    }
    if (!row.descriptionMd) {
      row = (await fetchJobDetailViaAgent(ctx, row)) ?? row;
    }

    const job = toJob(row);
    ctx.bus.emit({ type: 'job.scored', job }); // payload refresh for the dashboard
    if (!row.descriptionMd) {
      ctx.bus.emit({
        type: 'toast',
        level: 'warning',
        message: `No description could be fetched for ${row.company} — ${row.title}`,
      });
    }
    res.json({ job });
  });

  router.post('/jobs/:id/skip', (req, res) => {
    const id = idParam(req);
    const existing = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No job ${id}`);
    // Scam-verdict jobs stay quarantined (findable for manual review) — never
    // silently buried in 'skipped'.
    const status = existing.legitVerdict === 'scam' ? 'quarantined' : 'skipped';
    const row = ctx.db.update(jobs).set({ status }).where(eq(jobs.id, id)).returning().get();
    res.json(toJob(row));
  });

  // Manual legitimacy override: the user reviewed a suspicious/scam job and
  // vouches for it. Verdict → legit (note appended to the reasons trail),
  // status back to 'screened', and a rescore is queued when it never got a fit
  // score (quarantine used to preempt scoring).
  router.post('/jobs/:id/override-legit', (req, res) => {
    const id = idParam(req);
    const body = parseBody(
      z.object({ verdict: z.literal('legit'), note: z.string().min(1).max(500) }),
      req,
    );
    const existing = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No job ${id}`);
    let reasons: string[] = [];
    try {
      reasons = existing.legitReasonsJson ? (JSON.parse(existing.legitReasonsJson) as string[]) : [];
    } catch {
      reasons = [];
    }
    reasons.push(`[user override: ${body.note}]`);
    const row = ctx.db
      .update(jobs)
      .set({ legitVerdict: body.verdict, legitReasonsJson: JSON.stringify(reasons), status: 'screened' })
      .where(eq(jobs.id, id))
      .returning()
      .get();
    let taskId: number | null = null;
    if (row.fitScore == null) {
      taskId = ctx.queue.enqueue('score', { priority: PRIORITY.user, payload: { jobId: id, rescore: true } }).id;
    }
    ctx.bus.emit({ type: 'job.scored', job: toJob(row) });
    res.json({ job: toJob(row), taskId });
  });

  // Dashboard-requested: pre-application status transitions only. Application
  // lifecycle statuses (tailoring, applied, interview, …) belong to the
  // application record and its gates — never to a bare job PATCH.
  const PRE_APPLICATION = ['discovered', 'screened', 'skipped', 'quarantined'] as const;
  router.patch('/jobs/:id', (req, res) => {
    const id = idParam(req);
    const body = parseBody(z.object({ status: z.string() }), req);
    if (!(PRE_APPLICATION as readonly string[]).includes(body.status)) {
      throw new ApiError(
        400,
        'validation_error',
        `status must be one of ${PRE_APPLICATION.join(', ')} — application-lifecycle statuses are managed via /api/applications`,
      );
    }
    const existing = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!existing) throw new ApiError(404, 'not_found', `No job ${id}`);
    if (!(PRE_APPLICATION as readonly string[]).includes(existing.status)) {
      throw new ApiError(
        409,
        'invalid_state',
        `Job ${id} is ${existing.status} (application in flight) — use the application endpoints instead`,
      );
    }
    const row = ctx.db.update(jobs).set({ status: body.status }).where(eq(jobs.id, id)).returning().get();
    ctx.bus.emit({ type: 'job.scored', job: toJob(row) }); // job payload refresh for the dashboard
    res.json(toJob(row));
  });

  return router;
}
