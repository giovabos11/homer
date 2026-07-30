// Settings live in the settings table (key → JSON value). Seeded from config/default.json.
// Internal keys (queue pause flag, etc.) are namespaced with "internal." and never
// exposed through GET/PATCH /api/settings.
import { eq } from 'drizzle-orm';
import type { Settings } from '@shared/types';
import type { Db } from './db/client';
import { settingsTable } from './db/schema';

export const SETTINGS_KEYS: (keyof Settings)[] = [
  'gateMode',
  'hybridThreshold',
  'discoveryIntervalMinutes',
  'emailScanIntervalMinutes',
  'country',
  'applyDriver',
  'perSourceGates',
  'followupAfterDays',
  'maxFollowups',
];

export class SettingsStore {
  constructor(
    private db: Db,
    private defaults: Settings,
  ) {}

  /** Insert any missing settings keys from defaults. Existing values win. */
  seed(): void {
    for (const key of SETTINGS_KEYS) {
      const existing = this.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
      if (!existing) {
        this.db.insert(settingsTable).values({ key, value: JSON.stringify(this.defaults[key]) }).run();
      }
    }
  }

  get(): Settings {
    const rows = this.db.select().from(settingsTable).all();
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const out = { ...this.defaults } as Record<string, unknown>;
    for (const key of SETTINGS_KEYS) {
      const raw = map.get(key);
      if (raw !== undefined) {
        try {
          out[key] = JSON.parse(raw);
        } catch {
          /* keep default */
        }
      }
    }
    return out as unknown as Settings;
  }

  patch(partial: Partial<Settings>): Settings {
    for (const key of SETTINGS_KEYS) {
      if (key in partial && partial[key] !== undefined) {
        this.setRaw(key, JSON.stringify(partial[key]));
      }
    }
    return this.get();
  }

  // --- internal (not part of the Settings API shape) ---

  getInternal<T>(key: string, fallback: T): T {
    const row = this.db.select().from(settingsTable).where(eq(settingsTable.key, `internal.${key}`)).get();
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setInternal(key: string, value: unknown): void {
    this.setRaw(`internal.${key}`, JSON.stringify(value));
  }

  private setRaw(key: string, value: string): void {
    this.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
      .run();
  }
}
