// Test harness: in-memory DB, temp data dir, MemoryVault, MockRunner, stubbed
// connection probes (no shelling out), controllable clock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import { createContext, type AppContext, type ContextOptions } from '../src/context';
import type { ServerConfig } from '../src/config';
import { MockRunner, type MockScript } from '../src/agent/mock-runner';
import { MemoryVault } from '../src/vault';
import { QueueRunner } from '../src/queue/runner';
import { registerAllWorkers } from '../src/workers';

export interface TestWorld {
  ctx: AppContext;
  runner: QueueRunner;
  mockAgent: MockRunner;
  clock: { now: number; advance(ms: number): void };
  cleanup(): void;
}

export interface WorldOpts {
  simulate?: boolean;
  config?: Partial<ServerConfig>;
  /** Scripted MockRunner replies (route on prompt content). */
  script?: MockScript;
  /** Hermetic repo root (see makeFakeRepo) — real workers never touch the real repo in tests. */
  repoRoot?: string;
  renderer?: ContextOptions['renderer'];
  applyDriverFactory?: ContextOptions['applyDriverFactory'];
  /**
   * Stubbed HTTP for the pre-apply checks (liveness, ATS boards, redirects).
   * Defaults to an offline stub: no test ever reaches the open internet, and an
   * unreachable posting is treated as inconclusive (never as expired).
   */
  httpFetch?: ContextOptions['httpFetch'];
}

/** Offline default: every request fails, which the liveness check reads as "unknown". */
export const offlineFetch: NonNullable<ContextOptions['httpFetch']> = async () => {
  throw new Error('network disabled in tests');
};

/**
 * Build a stub fetch from a URL → response map. Values may be a string body
 * (200) or `{ status, body, headers }`. Unlisted URLs 404.
 */
export function stubFetch(
  routes: Record<string, string | { status?: number; body?: string; headers?: Record<string, string> }>,
): NonNullable<ContextOptions['httpFetch']> {
  return async (url: string) => {
    const hit = routes[url];
    const spec = typeof hit === 'string' ? { status: 200, body: hit } : (hit ?? { status: 404, body: 'Not Found' });
    const headers = spec.headers ?? {};
    return {
      status: spec.status ?? 200,
      url,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
      text: async () => spec.body ?? '',
    };
  };
}

export function makeWorld(opts: WorldOpts = {}): TestWorld {
  registerAllWorkers(); // idempotent — worlds without an HTTP app still run workers
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajs-server-test-'));
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      this.now += ms;
    },
  };
  const mockAgent = opts.script ? new MockRunner(opts.script) : new MockRunner();
  const ctx = createContext({
    dbPath: ':memory:',
    dataDir,
    simulate: opts.simulate ?? true,
    vault: new MemoryVault(),
    runner: mockAgent,
    clock: () => clock.now,
    config: opts.config,
    repoRoot: opts.repoRoot,
    renderer: opts.renderer,
    applyDriverFactory: opts.applyDriverFactory,
    httpFetch: opts.httpFetch ?? offlineFetch,
    probes: {
      claudeVersion: async () => '2.1.0 (Claude Code) [test]',
      playwrightResolvable: async () => true,
    },
  });
  const runner = new QueueRunner(ctx);
  return {
    ctx,
    runner,
    mockAgent,
    clock,
    cleanup() {
      runner.stop();
      ctx.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Hermetic fake repo for real-worker tests: a temp dir with CLAUDE.md identity,
 * the profile skill files the prompts/parsers read (01/03/04/07/08), and a
 * documents/ dir — so tailoring archives, retro appends, and screening-default
 * parsing never touch the real repository.
 */
export function makeFakeRepo(): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ajs-fake-repo-'));
  const skillDir = path.join(root, '.claude', 'skills', 'job-application-assistant');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'documents'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'CLAUDE.md'),
    [
      '# Test Candidate — Career Context',
      '',
      '- **Name:** Test Candidate',
      '- **Location:** Dallas, TX 75231, USA',
      '- **Phone:** +1 555-010-0000',
      '- **Email:** test.candidate@example.com',
      '- **Portfolio:** https://example.dev | **GitHub:** https://github.com/testcandidate',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(skillDir, '01-candidate-profile.md'),
    '# Candidate Profile\n\nFull-stack developer. TypeScript, React, Node.js, SQL. B.S. Computer Science (2025).\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(skillDir, '03-writing-style.md'),
    '# Writing Style Guide\n\n1. NO em-dashes. 2. No cliches.\n',
    'utf8',
  );
  fs.writeFileSync(path.join(skillDir, '04-job-evaluation.md'), '# Job Evaluation Framework\n\nWeights 30/25/15/30.\n', 'utf8');
  fs.writeFileSync(path.join(skillDir, '07-interview-prep.md'), '# Interview Preparation Guide\n\n## STAR Format\n', 'utf8');
  fs.writeFileSync(
    path.join(skillDir, '08-application-forms.md'),
    [
      '# Application Form Fields',
      '',
      '## Candidate screening defaults (Test Candidate)',
      '',
      '| Question | Default answer |',
      '|----------|----------------|',
      '| Are you authorized to work in the US? | Yes, for any employer |',
      '| Will you now or in the future require sponsorship? | No |',
      '| Are you willing to relocate? | Yes, anywhere in the US |',
      '| Are you available full-time? | Yes |',
      '| Are you 18 years or older? | Yes |',
      '| Location | Dallas, TX 75231 |',
      '| Phone / Email | +1 555-010-0000 / test.candidate@example.com |',
      '| Salary expectations | **Do not answer.** Flag the question to the candidate. |',
      '| Earliest start date | **Do not answer.** Not preset; flag to the candidate. |',
      '| Security clearance / citizenship questions | **Do not answer.** Flag to the candidate. |',
      '| Skills, tools, or experience not in the profile | **Do not answer.** Flag to the candidate; never invent. |',
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function makeApp(world: TestWorld) {
  return createApp(world.ctx);
}
