// Portal-skill discovery: glob .agents/skills/*/SKILL.md and parse the YAML
// frontmatter (name + enabled flag). Skills follow the upstream portal contract:
//   bun run .agents/skills/<name>/cli/src/cli.ts search --query … --format json
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../util/paths';

export interface PortalSkill {
  /** Skill directory name, e.g. "freehire-search". */
  name: string;
  /**
   * Source key = skill name without the -search suffix, hyphens normalized to
   * underscores so it matches ConnectionName (e.g. "ats-boards-search" → "ats_boards").
   */
  source: string;
  enabled: boolean;
  cliPath: string; // relative to repo root, forward slashes (bun arg)
  dir: string; // absolute skill dir
}

/** Minimal frontmatter parse: the block between the first pair of --- lines. */
function parseFrontmatter(md: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(md);
  const out: Record<string, string> = {};
  if (!match?.[1]) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    const comment = value.indexOf('#');
    if (comment >= 0) value = value.slice(0, comment).trim();
    out[key] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

export function discoverSkills(root: string = repoRoot()): PortalSkill[] {
  const skillsDir = path.join(root, '.agents', 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const skills: PortalSkill[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
    const cliTs = path.join(skillsDir, entry.name, 'cli', 'src', 'cli.ts');
    if (!fs.existsSync(skillMd) || !fs.existsSync(cliTs)) continue;
    const fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
    skills.push({
      name: fm.name ?? entry.name,
      source: entry.name.replace(/-search$/, '').replace(/-/g, '_'),
      enabled: (fm.enabled ?? 'true').toLowerCase() !== 'false',
      cliPath: `.agents/skills/${entry.name}/cli/src/cli.ts`,
      dir: path.join(skillsDir, entry.name),
    });
  }
  return skills.sort((a, b) => a.source.localeCompare(b.source));
}

export function enabledSkills(root: string = repoRoot(), allowlist: string[] | null = null): PortalSkill[] {
  return discoverSkills(root).filter(
    (s) => s.enabled && (allowlist == null || allowlist.includes(s.source) || allowlist.includes(s.name)),
  );
}

/** Resolve the bun executable: PATH first, then %USERPROFILE%\.bun\bin\bun.exe. */
export function resolveBun(): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `bun${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    const fallback = path.join(home, '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (fs.existsSync(fallback)) return fallback;
  }
  return null;
}
