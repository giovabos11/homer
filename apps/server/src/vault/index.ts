import { KeyringVault } from './keyring-vault';
import { FileVault } from './file-vault';
import type { Vault } from './types';

export type { Vault } from './types';
export { MemoryVault } from './types';

/**
 * Prefer the OS keyring (Windows Credential Manager); fall back to the
 * AES-256-GCM encrypted file vault when the native module is unavailable.
 */
export function createVault(dataDir: string): Vault {
  const keyring = KeyringVault.tryCreate();
  if (keyring) return keyring;
  console.warn('[vault] @napi-rs/keyring unavailable — using encrypted-file fallback');
  return new FileVault(dataDir);
}
