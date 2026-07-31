// ClaudeCodeRunner — runs `claude -p --output-format stream-json --verbose`
// headlessly on the user's subscription login (PRD D6).
//
// Invariants:
//  - ANTHROPIC_API_KEY is DELETED from the child env so subscription OAuth wins.
//  - --bare is never passed (it would bypass OAuth).
//  - The prompt is written to stdin (never a shell-quoted argv), so Windows
//    cmd/.cmd shim quoting can never mangle or inject through it.
import { spawn, execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../util/paths';
import { extractStructured, type AgentRunner, type AgentRunOptions, type AgentRunResult } from './types';

/** Rejection used when a run is cancelled by the user (never a crash). */
export class AgentAborted extends Error {
  constructor() {
    super('Agent run aborted');
    this.name = 'AbortError';
  }
}

/**
 * Kill a spawned CLI and everything it spawned. On Windows `child.kill()` only
 * kills the direct child, leaving the real `claude`/node process alive, so the
 * tree is killed with taskkill and child.kill() is the fallback everywhere.
 */
export function killTree(pid: number | undefined, child?: ChildProcess): void {
  if (pid && process.platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
      return;
    } catch {
      /* fall through to kill() */
    }
  }
  try {
    if (pid && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
  } catch {
    /* not a process group leader — fall through */
  }
  try {
    child?.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

interface ResolvedCommand {
  command: string;
  prefixArgs: string[];
}

let cachedCommand: ResolvedCommand | null | undefined;

/**
 * Resolve how to spawn the Claude CLI on this machine.
 * Windows global installs are usually a .cmd shim wrapping
 * node_modules/@anthropic-ai/claude-code/cli.js — we prefer spawning node on the
 * real cli.js (no cmd.exe in the middle); a native .exe is used directly.
 */
export function resolveClaudeCommand(): ResolvedCommand | null {
  if (cachedCommand !== undefined) return cachedCommand;
  cachedCommand = null;
  try {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(locator, ['claude'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const lower = line.toLowerCase();
      if (lower.endsWith('.exe') || (!lower.endsWith('.cmd') && !lower.endsWith('.bat') && !lower.endsWith('.ps1'))) {
        cachedCommand = { command: line, prefixArgs: [] };
        return cachedCommand;
      }
      // .cmd shim → find the real cli.js next to it.
      const cli = path.join(path.dirname(line), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) {
        cachedCommand = { command: process.execPath, prefixArgs: [cli] };
        return cachedCommand;
      }
      // Last resort: run the shim through cmd.exe. Safe because our argv
      // contains no user-controlled strings (prompt goes over stdin).
      cachedCommand = { command: process.env.ComSpec ?? 'cmd.exe', prefixArgs: ['/d', '/s', '/c', line] };
      return cachedCommand;
    }
  } catch {
    /* claude not found */
  }
  return cachedCommand;
}

export class ClaudeCodeRunner implements AgentRunner {
  constructor(private defaults: { cwd?: string; timeoutMs?: number } = {}) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const resolved = resolveClaudeCommand();
    if (!resolved) {
      throw new Error('Claude Code CLI not found on PATH. Install it or check the Connections panel.');
    }

    if (opts.signal?.aborted) throw new AgentAborted();

    const args = [...resolved.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose'];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
    // Per-task model routing: the CLI accepts the aliases haiku/sonnet/opus;
    // 'default' (or unset) keeps the user's own Claude Code default model.
    if (opts.model && opts.model !== 'default') args.push('--model', opts.model);

    // Subscription OAuth must win: an inherited API key would silently switch billing.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const cwd = opts.cwd ?? this.defaults.cwd ?? repoRoot();
    const timeoutMs = opts.timeoutMs ?? this.defaults.timeoutMs ?? 300000;

    return await new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(resolved.command, args, { cwd, env, windowsHide: true });
      let sessionId = opts.sessionId ?? '';
      let resultText = '';
      let assistantText = '';
      let stderr = '';
      let buffer = '';
      let settled = false;
      let isError = false;
      let resultSubtype: string | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree(child.pid, child);
        reject(new Error(`Claude Code run timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();

      // User cancellation: kill the whole process tree (the CLI spawns
      // children of its own; child.kill() alone can orphan them on Windows).
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree(child.pid, child);
        reject(new AgentAborted());
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', () => opts.signal?.removeEventListener('abort', onAbort));
      }

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return; // non-JSON noise on stdout
        }
        if (typeof event.session_id === 'string') sessionId = event.session_id;
        if (event.type === 'assistant') {
          const message = event.message as { content?: { type?: string; text?: string }[] } | undefined;
          for (const block of message?.content ?? []) {
            if (block.type === 'text' && block.text) assistantText += block.text;
          }
        }
        if (event.type === 'result') {
          if (typeof event.result === 'string') resultText = event.result;
          // Usage-limit / max-turns / execution errors: the result text is an
          // error notice, not an answer — flag it so callers don't try to parse it.
          if (event.is_error === true) isError = true;
          if (typeof event.subtype === 'string') resultSubtype = event.subtype;
        }
        opts.onEvent?.(event as { type: string });
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf('\n');
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        handleLine(buffer);
        if (code !== 0 && !resultText && !assistantText) {
          reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        const text = resultText || assistantText;
        resolve({ text, sessionId, structured: extractStructured(text), isError, resultSubtype });
      });

      child.stdin.write(opts.prompt);
      child.stdin.end();
    });
  }
}
