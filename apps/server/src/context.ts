// AppContext — everything the API routes and workers share, built once at boot
// (and per-test with overrides).
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunner } from './agent/types';
import { ClaudeCodeRunner, resolveClaudeCommand } from './agent/claude-code-runner';
import { MockRunner } from './agent/mock-runner';
import { loadConfig, isSimulate, type ServerConfig } from './config';
import { openDb, type Db, type DbHandle } from './db/client';
import { EventBus } from './events/bus';
import { BudgetManager, type Clock } from './queue/budgets';
import { CancellationRegistry } from './queue/cancellation';
import { TaskQueue } from './queue/queue';
import { Scheduler } from './queue/scheduler';
import { SettingsStore } from './settings';
import { StandingAnswerStore } from './docs/standing';
import { migrateApplicationAdvisories } from './docs/advisories';
import { refreshStandingResolvedAnswers } from './docs/answer-refresh';
import { discoverSkills } from './sources/skills';
import { ConnectionsMonitor, type Probes } from './connections/monitor';
import { createVault, type Vault } from './vault';
import { PlaywrightPdfRenderer, type PdfRenderer } from './docs/render';
import type { ApplyDriver } from './apply/driver';
import { PlaywrightApplyDriver } from './apply/playwright-driver';
import { ChromeApplyDriver } from './apply/chrome-driver';
import { ensureDir, repoRoot, serverRoot } from './util/paths';

export interface AppContext {
  config: ServerConfig;
  repoRoot: string;
  dataDir: string;
  artifactsDir: string;
  handle: DbHandle;
  db: Db;
  bus: EventBus;
  settings: SettingsStore;
  /** "Answer once, reuse forever" screening answers (FR-9). */
  standing: StandingAnswerStore;
  budgets: BudgetManager;
  queue: TaskQueue;
  /** Abort controllers for in-flight tasks — how cancel reaches a running CLI. */
  cancellations: CancellationRegistry;
  scheduler: Scheduler;
  vault: Vault;
  runner: AgentRunner;
  monitor: ConnectionsMonitor;
  /** HTML → PDF renderer (headless Chromium by default; tests inject a fake). */
  renderer: PdfRenderer;
  /** Builds the apply driver named in settings (tests inject fakes). */
  applyDriverFactory: (name: 'playwright' | 'chrome') => ApplyDriver;
  simulate: boolean;
  version: string;
  close(): void;
}

export interface ContextOptions {
  dbPath?: string;
  dataDir?: string;
  repoRoot?: string;
  config?: Partial<ServerConfig>;
  vault?: Vault;
  runner?: AgentRunner;
  probes?: Partial<Probes>;
  clock?: Clock;
  simulate?: boolean;
  renderer?: PdfRenderer;
  applyDriverFactory?: (name: 'playwright' | 'chrome') => ApplyDriver;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createContext(options: ContextOptions = {}): AppContext {
  const config = loadConfig(options.config ?? {});
  const root = options.repoRoot ?? repoRoot();
  const dataDir = ensureDir(options.dataDir ?? path.join(serverRoot(), 'data'));
  const artifactsDir = ensureDir(path.join(dataDir, 'artifacts'));
  const dbPath = options.dbPath ?? path.join(dataDir, 'app.db');

  const handle = openDb(dbPath);

  // One-time repair, idempotent and safe to run on every boot: drafting notes
  // that older builds wrote into applications.answers_json as "FLAG: …"
  // needs-user markers move into advisories_json, where they cannot block an
  // approval. Real answers are untouched.
  const repaired = migrateApplicationAdvisories(handle.db);
  if (repaired.changed > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[advisories] moved ${repaired.movedEntries} drafting note(s) out of screening answers ` +
        `across ${repaired.changed} application(s)`,
    );
  }

  const bus = new EventBus();
  const settings = new SettingsStore(handle.db, config.settings);
  settings.seed();

  const standing = new StandingAnswerStore(handle.db);

  // Applications drafted before a standing answer existed still ask for it.
  // Re-apply the first resolution layer so the user is never asked twice for
  // something they have already answered once. Fills from the user's own
  // values only; never approves or submits.
  const refreshed = refreshStandingResolvedAnswers(handle.db, standing.get());
  if (refreshed.changed > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[standing] filled ${refreshed.resolved} question(s) from your standing answers ` +
        `across ${refreshed.changed} application(s)`,
    );
  }

  const clock = options.clock ?? (() => Date.now());
  const budgets = new BudgetManager(handle.db, config.budgets.default, config.budgets.perSource, clock);
  // Seed a budget row per installed portal skill. The SKILL.md `enabled:`
  // frontmatter only SEEDS the flag the first time a source is seen; after that
  // source_budgets.enabled is the runtime authority so a dashboard toggle is
  // never silently reverted at the next boot (PRD §11).
  for (const skill of discoverSkills(root)) {
    if (budgets.ensure(skill.source)) budgets.setEnabled(skill.source, skill.enabled);
  }

  const queue = new TaskQueue(handle, settings, config.queue, clock);
  const scheduler = new Scheduler(queue, settings, config);
  const vault = options.vault ?? createVault(dataDir);
  const simulate = options.simulate ?? isSimulate();

  const runner =
    options.runner ?? (simulate || !resolveClaudeCommand() ? new MockRunner() : new ClaudeCodeRunner({ cwd: root }));

  const renderer = options.renderer ?? new PlaywrightPdfRenderer();
  const applyDriverFactory =
    options.applyDriverFactory ??
    ((name: 'playwright' | 'chrome'): ApplyDriver =>
      name === 'chrome'
        ? new ChromeApplyDriver()
        : new PlaywrightApplyDriver({ profileDir: path.join(dataDir, 'browser-profile') }));

  const ctx: AppContext = {
    config,
    repoRoot: root,
    dataDir,
    artifactsDir,
    handle,
    db: handle.db,
    bus,
    settings,
    standing,
    budgets,
    queue,
    cancellations: new CancellationRegistry(),
    scheduler,
    vault,
    runner,
    monitor: undefined as unknown as ConnectionsMonitor, // set below (monitor needs ctx)
    renderer,
    applyDriverFactory,
    simulate,
    version: readVersion(),
    close() {
      scheduler.stop();
      bus.close();
      void renderer.dispose().catch(() => undefined);
      handle.sqlite.close();
    },
  };
  ctx.monitor = new ConnectionsMonitor(ctx, options.probes);
  return ctx;
}
