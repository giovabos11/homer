// Windows Credential Manager backend via @napi-rs/keyring (PRD D8).
// One credential per ref under the "ai-job-search" service.
import type { Vault } from './types';

const SERVICE = 'ai-job-search';

type EntryCtor = new (service: string, account: string) => {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
};

export class KeyringVault implements Vault {
  readonly backend = 'keyring' as const;

  private constructor(private Entry: EntryCtor) {}

  /** Returns null when the native module cannot be loaded on this machine. */
  static tryCreate(): KeyringVault | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@napi-rs/keyring') as { Entry: EntryCtor };
      // Probe that the native binding actually works.
      const probe = new mod.Entry(`${SERVICE}-probe`, 'probe');
      probe.setPassword('ok');
      probe.deletePassword();
      return new KeyringVault(mod.Entry);
    } catch {
      return null;
    }
  }

  async get(ref: string): Promise<string | null> {
    try {
      return new this.Entry(SERVICE, ref).getPassword();
    } catch {
      return null; // NoEntry
    }
  }

  async set(ref: string, secret: string): Promise<void> {
    new this.Entry(SERVICE, ref).setPassword(secret);
  }

  async delete(ref: string): Promise<boolean> {
    try {
      return new this.Entry(SERVICE, ref).deletePassword();
    } catch {
      return false;
    }
  }
}
