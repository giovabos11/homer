// Connections monitor (FR-15): computes a Connection[] status card set for
// every integration. Probes are injectable (and cached) so tests and fast
// snapshots never shell out.
import { execFile } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { Connection, ConnectionName, ConnectionStatus } from '@shared/types';
import { connections as connectionsTable, sourceBudgets } from '../db/schema';
import { discoverSkills, resolveBun } from '../sources/skills';
import type { AppContext } from '../context';

export interface Probes {
  /** `claude --version` output, or null when the CLI is missing. */
  claudeVersion(): Promise<string | null>;
  /** Whether the Playwright MCP package resolves (npx @playwright/mcp). */
  playwrightResolvable(): Promise<boolean>;
}

const PORTAL_CONNECTIONS: ConnectionName[] = [
  'ats_boards', 'remoteok', 'remotive', 'weworkremotely', 'hn_hiring', 'freehire', 'linkedin',
];
const KEYED_CONNECTIONS: ConnectionName[] = ['adzuna', 'usajobs'];

// Probe commands run through a shell on Windows: npm-style CLIs are .cmd shims
// there, and Node ≥ 20.12 refuses to spawn .cmd without one (EINVAL). Argv is
// fixed strings only, so the shell is safe. Every failure resolves — probes
// must never throw into a request handler.
function probeExec(command: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout, windowsHide: true, shell: process.platform === 'win32' },
        (err, stdout) => resolve(err ? null : stdout.trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

function defaultProbes(): Probes {
  return {
    claudeVersion: () => probeExec('claude', ['--version'], 15000),
    playwrightResolvable: async () =>
      (await probeExec('npx', ['--no-install', '@playwright/mcp', '--version'], 20000)) !== null,
  };
}

export class ConnectionsMonitor {
  private probes: Probes;
  private cache: { at: number; list: Connection[] } | null = null;
  private cacheTtlMs = 5 * 60 * 1000;

  constructor(
    private ctx: AppContext,
    probes?: Partial<Probes>,
  ) {
    this.probes = { ...defaultProbes(), ...probes };
  }

  /** Full status list; probed results cached for 5 minutes. */
  async list(force = false): Promise<Connection[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.list;
    }
    const now = new Date().toISOString();
    const list: Connection[] = [];
    const push = (name: ConnectionName, status: ConnectionStatus, detail: string | null) => {
      const lastOk = status === 'ok' ? now : this.storedLastOk(name);
      list.push({ name, status, detail, lastOk });
      this.persist(name, status, detail, lastOk);
    };

    // server — if this code runs, the server is up.
    push('server', 'ok', `v${this.ctx.version} on 127.0.0.1:${this.ctx.config.port}`);

    // claude_code
    const claudeVersion = await this.probes.claudeVersion();
    push(
      'claude_code',
      claudeVersion ? 'ok' : 'down',
      claudeVersion ?? 'Claude Code CLI not found on PATH — install it and sign in with your subscription',
    );

    // playwright
    const pw = await this.probes.playwrightResolvable();
    push('playwright', pw ? 'ok' : 'down', pw ? '@playwright/mcp resolvable' : 'Run: npx @playwright/mcp (approve the install)');

    // gmail — session-only by design (PRD D4).
    push('gmail', 'waiting_session', 'Session-only connector: email tasks run when a Claude session is active');

    // chrome — manual/unknown by design: the user connects Claude in Chrome themselves.
    push('chrome', 'disabled', 'Manual: connect via the Claude in Chrome extension when applying to hostile sites');

    // portal skills
    const skills = new Map(discoverSkills(this.ctx.repoRoot).map((s) => [s.source, s]));
    const bun = resolveBun();
    for (const name of PORTAL_CONNECTIONS) {
      const skill = skills.get(name);
      if (!skill) {
        push(name, 'disabled', 'Portal skill not installed (US skills phase adds it)');
        continue;
      }
      if (!skill.enabled) {
        push(name, 'disabled', 'Skill installed but disabled (enabled: false in SKILL.md)');
        continue;
      }
      if (!bun) {
        push(name, 'down', 'bun executable not found — install Bun to run portal skills');
        continue;
      }
      const budget = this.ctx.db.select().from(sourceBudgets).where(eq(sourceBudgets.source, name)).get();
      const health = budget?.health ?? 'ok';
      push(
        name,
        health === 'ok' ? 'ok' : health === 'degraded' ? 'degraded' : 'down',
        budget ? `Budget: ${Math.floor(budget.tokens)} token(s) left, health ${health}` : 'Ready',
      );
    }

    // keyed sources — needs_key unless a key is in the vault.
    for (const name of KEYED_CONNECTIONS) {
      const key = await this.ctx.vault.get(`apikey:${name}`);
      push(name, key ? 'ok' : 'needs_key', key ? 'API key stored in vault' : 'Optional free API key unlocks this source');
    }

    this.cache = { at: Date.now(), list };
    return list;
  }

  async get(name: string, force = false): Promise<Connection | null> {
    const list = await this.list(force);
    return list.find((c) => c.name === name) ?? null;
  }

  invalidate(): void {
    this.cache = null;
  }

  private storedLastOk(name: string): string | null {
    const row = this.ctx.db.select().from(connectionsTable).where(eq(connectionsTable.name, name)).get();
    return row?.lastOk ?? null;
  }

  private persist(name: string, status: ConnectionStatus, detail: string | null, lastOk: string | null): void {
    this.ctx.db
      .insert(connectionsTable)
      .values({ name, status, detail, lastOk })
      .onConflictDoUpdate({ target: connectionsTable.name, set: { status, detail, lastOk } })
      .run();
  }
}
