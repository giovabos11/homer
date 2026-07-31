// Ask-anything worker (FR-29). REAL: streams an AgentRunner session (Claude
// Code headless in the repo root, so CLAUDE.md + profile skills auto-load as
// context) and forwards deltas to the dashboard as ask.delta SSE events.
// Conversational: the session id persists in the settings table (internal
// askSessionId) so consecutive asks resume the same Claude session; POST
// /api/ask/clear drops it. Runs on the configurable modelAsk (haiku default).
//
// FILE EDITING (PRD §11): the chat can EDIT the profile and search-query files
// without an interactive approval, which headless `claude -p` can never show.
//   - `--allowedTools` carries path-scoped Edit/Write rules covering exactly
//     the profile-files API safe-list plus the job-scraper search queries, so
//     an in-list edit is pre-approved and anything else is refused.
//   - A one-line appended system prompt tells the model that no approval
//     prompt exists, so a refused edit is reported instead of waited on — the
//     deadlock ("please approve the permission prompt") can no longer happen.
//   - Belt and braces: every Edit/Write tool call is observed on the event
//     stream. A write outside the safe-list is snapshotted the moment it is
//     announced and restored afterwards, and reported in the reply.
// After a turn that touched profile files the dashboard refetches the profile;
// a search-queries.md change toasts a "re-run discovery" suggestion.
import fs from 'node:fs';
import path from 'node:path';
import type { Worker, WorkerArgs } from './registry';

/** Editable surface — mirrors resolveProfileFilePath() plus the scraper queries. */
export const ASK_EDITABLE_PATTERNS: RegExp[] = [
  /^CLAUDE\.md$/,
  /^documents\/.+\.(md|txt)$/i,
  /^\.claude\/skills\/job-application-assistant\/[^/]+\.md$/,
  /^\.claude\/skills\/job-scraper\/search-queries\.md$/,
];

/** Claude Code permission rules that pre-approve exactly that surface. */
export const ASK_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit(CLAUDE.md)',
  'Edit(documents/**)',
  'Edit(.claude/skills/job-application-assistant/*.md)',
  'Edit(.claude/skills/job-scraper/search-queries.md)',
  'Write(CLAUDE.md)',
  'Write(documents/**)',
  'Write(.claude/skills/job-application-assistant/*.md)',
  'Write(.claude/skills/job-scraper/search-queries.md)',
  'MultiEdit(CLAUDE.md)',
  'MultiEdit(documents/**)',
  'MultiEdit(.claude/skills/job-application-assistant/*.md)',
  'MultiEdit(.claude/skills/job-scraper/search-queries.md)',
];

export const ASK_SYSTEM_NOTE =
  'This session is headless: no interactive permission prompt can ever appear, so never ask the user to approve one. ' +
  'You may edit only CLAUDE.md, documents/*.md|.txt, .claude/skills/job-application-assistant/*.md and ' +
  '.claude/skills/job-scraper/search-queries.md. If an edit is refused, say so plainly and paste the exact replacement text instead. ' +
  'Never edit application source code, agent skills, or anything under apps/.';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Repo-relative, forward-slashed path, or null when it escapes the repo. */
export function repoRelative(repoRoot: string, filePath: string): string | null {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return null;
    return rel;
  } catch {
    return null;
  }
}

export function isAskEditable(rel: string): boolean {
  return ASK_EDITABLE_PATTERNS.some((re) => re.test(rel));
}

interface Touched {
  rel: string;
  allowed: boolean;
  /** Pre-edit content of an out-of-list file, for the revert. null = did not exist. */
  backup: string | null;
}

export const askWorker: Worker = {
  type: 'ask',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { requestId?: string; prompt?: string; sessionId?: string };
    const requestId = payload.requestId ?? String(task.id);
    const prompt = payload.prompt ?? '';
    if (!prompt) return;

    const sessionId = payload.sessionId ?? ctx.settings.getInternal<string | null>('askSessionId', null) ?? undefined;
    const touched = new Map<string, Touched>();

    let streamed = '';
    const result = await ctx.runner.run({
      prompt,
      cwd: ctx.repoRoot,
      sessionId,
      model: ctx.settings.get().modelAsk,
      allowedTools: ASK_ALLOWED_TOOLS,
      appendSystemPrompt: ASK_SYSTEM_NOTE,
      timeoutMs: ctx.config.agent.defaultTimeoutMs,
      onEvent: (e) => {
        if (e.type !== 'assistant') return;
        const message = e.message as
          | { content?: { type?: string; text?: string; name?: string; input?: { file_path?: string } }[] }
          | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            streamed += block.text;
            ctx.bus.emit({ type: 'ask.delta', requestId, delta: block.text, done: false });
            continue;
          }
          if (block.type !== 'tool_use' || !block.name || !EDIT_TOOLS.has(block.name)) continue;
          const target = block.input?.file_path;
          if (!target) continue;
          const rel = repoRelative(ctx.repoRoot, target);
          if (!rel || touched.has(rel)) continue;
          const allowed = isAskEditable(rel);
          // Snapshot BEFORE the tool runs so an out-of-list write is reversible.
          let backup: string | null = null;
          if (!allowed) {
            try {
              const abs = path.join(ctx.repoRoot, rel);
              backup = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
            } catch {
              backup = null;
            }
          }
          touched.set(rel, { rel, allowed, backup });
        }
      },
    });

    // Remember the session so the next ask continues the conversation.
    if (result.sessionId) ctx.settings.setInternal('askSessionId', result.sessionId);

    const edited = [...touched.values()].filter((t) => t.allowed).map((t) => t.rel);
    const reverted = revertOutOfScope(ctx.repoRoot, [...touched.values()]);

    // If the runner produced a final text that streaming missed, send the remainder.
    if (result.text && result.text.length > streamed.length && result.text.startsWith(streamed)) {
      ctx.bus.emit({ type: 'ask.delta', requestId, delta: result.text.slice(streamed.length), done: false });
    }

    // Surface WHAT changed so the effect is visible in the dashboard.
    if (edited.length > 0 || reverted.length > 0) {
      const lines = ['', '', '---', ''];
      if (edited.length > 0) {
        lines.push(`**Files updated:** ${edited.map((f) => `\`${f}\``).join(', ')}`);
      }
      if (reverted.length > 0) {
        lines.push(
          `**Blocked and reverted (outside the editable safe-list):** ${reverted.map((f) => `\`${f}\``).join(', ')}`,
        );
      }
      ctx.bus.emit({ type: 'ask.delta', requestId, delta: lines.join('\n'), done: false });
    }
    ctx.bus.emit({ type: 'ask.delta', requestId, delta: '', done: true });

    if (edited.length > 0) {
      // Same post-write hooks the profile-files API fires: the dashboard
      // refetches the profile on `done`, so profileReady recomputes.
      ctx.bus.emit({
        type: 'toast',
        level: 'success',
        message: `Assistant updated ${edited.length} file${edited.length === 1 ? '' : 's'}: ${edited.join(', ')}`,
      });
      if (edited.some((f) => f.endsWith('search-queries.md'))) {
        ctx.bus.emit({
          type: 'toast',
          level: 'info',
          message: 'Search queries changed — run discovery again to pick up the new targeting',
        });
      }
    }
    if (reverted.length > 0) {
      ctx.bus.emit({
        type: 'toast',
        level: 'warning',
        message: `Assistant tried to edit outside its safe-list — reverted: ${reverted.join(', ')}`,
      });
    }
  },
};

/** Restore anything written outside the safe-list. Returns the reverted paths. */
function revertOutOfScope(repoRoot: string, touched: Touched[]): string[] {
  const reverted: string[] = [];
  for (const t of touched) {
    if (t.allowed) continue;
    const abs = path.join(repoRoot, t.rel);
    try {
      if (t.backup == null) {
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
      } else if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') !== t.backup) {
        fs.writeFileSync(abs, t.backup, 'utf8');
      } else {
        continue; // the write was refused before it happened — nothing to undo
      }
      reverted.push(t.rel);
    } catch {
      reverted.push(t.rel); // still report it, even if the restore failed
    }
  }
  return reverted;
}
