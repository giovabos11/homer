/**
 * Vault — secret storage behind a swappable backend (PRD D8, §8).
 * The DB stores only references (credentials_meta.vault_ref); secrets never touch
 * files or SQLite in plaintext.
 */
export interface Vault {
  /** Backend identifier, surfaced in health/diagnostics. */
  readonly backend: 'keyring' | 'file' | 'memory';
  get(ref: string): Promise<string | null>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<boolean>;
}

/** In-memory vault for tests. */
export class MemoryVault implements Vault {
  readonly backend = 'memory' as const;
  private store = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.store.get(ref) ?? null;
  }
  async set(ref: string, secret: string): Promise<void> {
    this.store.set(ref, secret);
  }
  async delete(ref: string): Promise<boolean> {
    return this.store.delete(ref);
  }
}
