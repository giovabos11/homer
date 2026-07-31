// Discovery worker (REAL — FR-1, FR-3). Iterates enabled portal skills
// sequentially, page by page, checking the global pause flag and the per-source
// token budget between pages. Cursor {sourceIndex, page} makes any interruption
// resumable from the exact source+page it stopped at. New jobs are deduped,
// upserted with full descriptions, announced via job.discovered, and queued for
// scoring.
import { toJob } from '../db/serialize';
import { hitToJobInput, upsertJob } from '../sources/dedupe';
import { fetchJobDetailFromPortal } from '../sources/enrich';
import { runPortalSearch, PortalCliError } from '../sources/portal-cli';
import { discoverSkills, resolveBun, type PortalSkill } from '../sources/skills';
import { activeSources } from '../api/sources';
import { PauseRequested, type Worker, type WorkerArgs } from './registry';

interface DiscoverPayload {
  trigger?: string;
  searchId?: string;
  keywords?: string;
  location?: string;
  remote?: string;
  sources?: string[];
}

interface DiscoverCursor extends Record<string, unknown> {
  sourceIndex: number;
  page: number;
}

const FAKE_COMPANIES = ['Nimbus Labs', 'Vector Systems', 'Bluegrid', 'Parallel Works', 'Hexa Cloud', 'Signalpath'];
const FAKE_TITLES = [
  'Software Engineer',
  'Full-Stack Developer',
  'Backend Engineer (TypeScript)',
  'React Native Developer',
  'Platform Engineer',
];

export const discoveryWorker: Worker = {
  type: 'discover',
  async run({ ctx, task, paused, saveCursor }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as DiscoverPayload;
    const cursor = (task.cursorJson ? JSON.parse(task.cursorJson) : { sourceIndex: 0, page: 1 }) as DiscoverCursor;
    const active = activeSources(ctx);
    const query = payload.keywords?.trim() || ctx.config.discovery.defaultQuery;
    // A manual search names its own sources and wins. A SCHEDULED sweep uses
    // the dashboard toggles (source_budgets.enabled, key-gating included) —
    // never the SKILL.md frontmatter, which only ever seeds those toggles.
    const allSkills = discoverSkills(ctx.repoRoot);
    const skills = payload.sources
      ? allSkills.filter((s) => payload.sources!.includes(s.source) || payload.sources!.includes(s.name))
      : allSkills.filter(
          (s) =>
            active.includes(s.source) &&
            (ctx.config.discovery.skillAllowlist == null || ctx.config.discovery.skillAllowlist.includes(s.source)),
        );

    if (ctx.simulate) {
      simulateDiscovery(ctx, task.id, skills, query);
      return;
    }

    const bun = resolveBun();
    if (!bun) {
      for (const skill of skills) ctx.budgets.setHealth(skill.source, 'down');
      ctx.bus.emit({
        type: 'toast',
        level: 'warning',
        message: 'Discovery skipped: bun executable not found (install Bun to run portal skills)',
      });
      return;
    }

    for (let i = cursor.sourceIndex; i < skills.length; i += 1) {
      const skill = skills[i]!;
      const startPage = i === cursor.sourceIndex ? cursor.page : 1;

      for (let page = startPage; page <= ctx.config.discovery.maxPagesPerSource; page += 1) {
        if (paused()) {
          saveCursor({ sourceIndex: i, page });
          throw new PauseRequested();
        }
        const budget = ctx.budgets.take(skill.source);
        if (!budget.ok) break; // budget exhausted → move on; refill happens over time

        let hits;
        try {
          const result = await runPortalSearch(bun, skill, {
            query,
            location: payload.location,
            page,
            limit: ctx.config.discovery.pageSize,
          });
          hits = result.hits;
          ctx.budgets.setHealth(skill.source, 'ok');
        } catch (err) {
          ctx.budgets.setHealth(skill.source, err instanceof PortalCliError ? 'degraded' : 'down');
          break; // this source is unhealthy this run; continue with the next one
        }

        for (const hit of hits) {
          if (!hit.url && !hit.id) continue;
          const { job, inserted } = upsertJob(ctx.db, hitToJobInput(skill.source, hit));
          if (inserted) {
            // Enrichment: card-only search output (no description) → run the
            // skill's `detail` command for NEW jobs only. Budget-checked inside
            // the helper; a failing detail never blocks discovery. When the
            // queue pauses mid-page we skip the fetch (the score worker's
            // fetch-first guard backfills later) rather than losing the job.
            let row = job;
            if (!row.descriptionMd && !paused()) {
              row = (await fetchJobDetailFromPortal(ctx, row, { skill, bun })) ?? row;
            }
            ctx.bus.emit({ type: 'job.discovered', job: toJob(row) });
            ctx.queue.enqueue('score', { payload: { jobId: row.id } });
          }
        }
        saveCursor({ sourceIndex: i, page: page + 1 });
        if (hits.length < ctx.config.discovery.pageSize) break; // last page reached
      }
      saveCursor({ sourceIndex: i + 1, page: 1 });
    }
  },
};

/** SIMULATE=1: fabricate a few plausible jobs per source so the dashboard fills up. */
function simulateDiscovery(ctx: WorkerArgs['ctx'], taskId: number, skills: PortalSkill[], query: string): void {
  const sources = skills.length > 0 ? skills.map((s) => s.source) : ['freehire', 'linkedin'];
  let n = 0;
  for (const source of sources) {
    for (let k = 0; k < 2; k += 1) {
      const company = FAKE_COMPANIES[(taskId + n * 3) % FAKE_COMPANIES.length]!;
      const title = FAKE_TITLES[(taskId + n) % FAKE_TITLES.length]!;
      const salaryBase = 95000 + ((taskId * 7 + n * 13) % 60) * 1000;
      const { job, inserted } = upsertJob(ctx.db, {
        source,
        externalId: `sim-${taskId}-${n}`,
        canonicalUrl: `https://example.com/${source}/jobs/sim-${taskId}-${n}`,
        company,
        title: `${title} — ${query}`,
        location: n % 2 === 0 ? null : 'Dallas, TX',
        remoteType: n % 2 === 0 ? 'remote' : 'hybrid',
        salaryMin: salaryBase,
        salaryMax: salaryBase + 25000,
        salaryCurrency: 'USD',
        descriptionMd: `## ${title}\n\n${company} is hiring. Simulated posting for dashboard demos (query: "${query}", source: ${source}).`,
        postedAt: new Date(Date.now() - n * 86400000).toISOString(),
        raw: { simulated: true, source, query },
      });
      if (inserted) {
        ctx.bus.emit({ type: 'job.discovered', job: toJob(job) });
        ctx.queue.enqueue('score', { payload: { jobId: job.id } });
      }
      n += 1;
    }
  }
}
