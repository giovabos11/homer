import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '@shared/types';
import { serverRoot } from './util/paths';

export interface BudgetSpec {
  capacity: number;
  refillPerHour: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  settings: Settings;
  queue: {
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    pollIntervalMs: number;
    followupSweepCron: string;
  };
  discovery: {
    defaultQuery: string;
    maxPagesPerSource: number;
    pageSize: number;
    skillAllowlist: string[] | null;
  };
  budgets: {
    default: BudgetSpec;
    perSource: Record<string, BudgetSpec>;
  };
  agent: {
    defaultTimeoutMs: number;
  };
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const file = path.join(serverRoot(), 'config', 'default.json');
  const base = JSON.parse(fs.readFileSync(file, 'utf8')) as ServerConfig;
  const merged: ServerConfig = {
    ...base,
    ...overrides,
    settings: { ...base.settings, ...(overrides.settings ?? {}) },
    queue: { ...base.queue, ...(overrides.queue ?? {}) },
    discovery: { ...base.discovery, ...(overrides.discovery ?? {}) },
    budgets: {
      default: { ...base.budgets.default, ...(overrides.budgets?.default ?? {}) },
      perSource: { ...base.budgets.perSource, ...(overrides.budgets?.perSource ?? {}) },
    },
    agent: { ...base.agent, ...(overrides.agent ?? {}) },
  };
  if (process.env.PORT) merged.port = Number(process.env.PORT);
  return merged;
}

/** SIMULATE=1 makes stub workers produce realistic fake outcomes for dashboard demos. */
export function isSimulate(): boolean {
  return process.env.SIMULATE === '1' || process.env.SIMULATE === 'true';
}
