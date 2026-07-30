import fs from 'node:fs';
import path from 'node:path';

/** Walk up from a start dir until a predicate matches. */
function findUp(start: string, predicate: (dir: string) => boolean): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** apps/server root — located by walking up from this file to the package.json named @ai-job-search/server. */
export function serverRoot(): string {
  const found = findUp(__dirname, (dir) => {
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) return false;
    try {
      return JSON.parse(fs.readFileSync(pkg, 'utf8')).name === '@ai-job-search/server';
    } catch {
      return false;
    }
  });
  if (!found) throw new Error('Could not locate apps/server root');
  return found;
}

/** Repo root (the ai-job-search fork) = two levels above apps/server. */
export function repoRoot(): string {
  return path.resolve(serverRoot(), '..', '..');
}

/** Resolve a path safely inside a root; throws on traversal outside it. */
export function safeJoin(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Path escapes allowed root: ${relative}`);
  }
  return resolved;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
