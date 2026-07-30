// Runs a portal skill CLI (upstream portal contract) and parses its JSON output.
// Contract: `search --query … --location … --jobage N --page N --limit N --format json`
// → stdout JSON; errors as JSON on stderr with non-zero exit; backoff on 429/5xx
// is the CLI's job — ours is per-source budgets.
import { execFile } from 'node:child_process';
import { repoRoot } from '../util/paths';
import type { PortalSkill } from './skills';

export interface PortalSearchParams {
  query: string;
  location?: string;
  page?: number;
  limit?: number;
  jobageDays?: number;
}

/** One hit as the portal contract emits it (fields beyond these are kept in raw). */
export interface PortalHit {
  id: string | null;
  title: string;
  company: string | null;
  location: string | null;
  date: string | null;
  url: string;
  description: string | null;
  workMode: string | null;
  salary: string | null;
  raw: Record<string, unknown>;
}

export interface PortalSearchResult {
  hits: PortalHit[];
  total: number | null;
}

export class PortalCliError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function mapHit(item: Record<string, unknown>): PortalHit {
  return {
    id: asString(item.id) ?? asString(item.external_id),
    title: asString(item.title) ?? '(untitled)',
    company: asString(item.company),
    location: asString(item.location),
    date: asString(item.date) ?? asString(item.posted_at),
    url: asString(item.url) ?? '',
    description: asString(item.description),
    workMode: asString(item.work_mode) ?? asString(item.workMode),
    salary: asString(item.salary),
    raw: item,
  };
}

export function runPortalSearch(
  bunPath: string,
  skill: PortalSkill,
  params: PortalSearchParams,
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<PortalSearchResult> {
  const args = [
    'run',
    skill.cliPath,
    'search',
    '--query',
    params.query,
    '--page',
    String(params.page ?? 1),
    '--limit',
    String(params.limit ?? 25),
    '--format',
    'json',
  ];
  if (params.location) args.push('--location', params.location);
  if (params.jobageDays != null) args.push('--jobage', String(params.jobageDays));

  return new Promise((resolve, reject) => {
    execFile(
      bunPath,
      args,
      {
        cwd: opts.cwd ?? repoRoot(),
        timeout: opts.timeoutMs ?? 60000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && !stdout.trim()) {
          let detail = stderr.trim().slice(0, 400);
          try {
            const parsed = JSON.parse(stderr.trim()) as { error?: string; message?: string };
            detail = parsed.error ?? parsed.message ?? detail;
          } catch {
            /* stderr not JSON */
          }
          const code = typeof (error as NodeJS.ErrnoException).code === 'number'
            ? ((error as NodeJS.ErrnoException).code as unknown as number)
            : null;
          reject(new PortalCliError(`${skill.source} search failed: ${detail || error.message}`, skill.source, code));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as unknown;
          const items: unknown[] = Array.isArray(parsed)
            ? parsed
            : Array.isArray((parsed as { results?: unknown[] }).results)
              ? (parsed as { results: unknown[] }).results
              : [];
          const meta = (parsed as { meta?: { total?: number } }).meta;
          resolve({
            hits: items.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null).map(mapHit),
            total: typeof meta?.total === 'number' ? meta.total : null,
          });
        } catch {
          reject(new PortalCliError(`${skill.source} returned non-JSON output`, skill.source, null));
        }
      },
    );
  });
}
