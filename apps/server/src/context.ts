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
import { TaskQueue } from './queue/queue';
import { Scheduler } from './queue/scheduler';
import { SettingsStore } from './settings';
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
  budgets: BudgetManager;
  queue: TaskQueue;
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
  const bus = new EventBus();
  const settings = new SettingsStore(handle.db, config.settings);
  settings.seed();

  const clock = options.clock ?? (() => Date.now());
  const budgets = new BudgetManager(handle.db, config.budgets.default, config.budgets.perSource, clock);
  // Seed budget rows for every installed portal skill, syncing the enabled
  // flag from the skill frontmatter so disabled portals (Danish demo set,
  // key-gated sources without keys) don't show as active sources in the
  // dashboard queue panel.
  for (const skill of discoverSkills(root)) {
    budgets.ensure(skill.source);
    budgets.setEnabled(skill.source, skill.enabled);
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
    budgets,
    queue,
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
