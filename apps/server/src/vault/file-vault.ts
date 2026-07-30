// AES-256-GCM encrypted-file fallback vault, used only when @napi-rs/keyring
// cannot load. Key material is a machine-local random 32-byte secret file under
// %APPDATA%\ai-job-search\vault.key (outside the repo, never committed); the
// encrypted store lives at <dataDir>/vault.enc.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Vault } from './types';

interface EncryptedEntry {
  iv: string; // base64
  tag: string; // base64
  data: string; // base64
}

interface StoreFile {
  version: 1;
  entries: Record<string, EncryptedEntry>;
}

export class FileVault implements Vault {
  readonly backend = 'file' as const;
  private key: Buffer;
  private storePath: string;

  constructor(dataDir: string, keyFilePath?: string) {
    const keyPath =
      keyFilePath ??
      path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'ai-job-search', 'vault.key');
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    if (!fs.existsSync(keyPath)) {
      fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
    }
    this.key = fs.readFileSync(keyPath);
    if (this.key.length !== 32) {
      // Derive a proper 256-bit key if the file was tampered with / hand-edited.
      this.key = crypto.createHash('sha256').update(this.key).digest();
    }
    fs.mkdirSync(dataDir, { recursive: true });
    this.storePath = path.join(dataDir, 'vault.enc');
  }

  private load(): StoreFile {
    if (!fs.existsSync(this.storePath)) return { version: 1, entries: {} };
    try {
      return JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as StoreFile;
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private save(store: StoreFile): void {
    fs.writeFileSync(this.storePath, JSON.stringify(store), { mode: 0o600 });
  }

  async get(ref: string): Promise<string | null> {
    const entry = this.load().entries[ref];
    if (!entry) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  async set(ref: string, secret: string): Promise<void> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const store = this.load();
    store.entries[ref] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    this.save(store);
  }

  async delete(ref: string): Promise<boolean> {
    const store = this.load();
    if (!(ref in store.entries)) return false;
    delete store.entries[ref];
    this.save(store);
    return true;
  }
}
