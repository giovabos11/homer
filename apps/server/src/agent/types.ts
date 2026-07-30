/**
 * AgentRunner — the seam that isolates the AI engine (PRD D6).
 * The default implementation shells out to Claude Code headless on the user's
 * subscription login; swapping providers means implementing this interface (or
 * pointing ANTHROPIC_BASE_URL at a gateway — see src/agent/README.md).
 */
export interface AgentEvent {
  /** Raw stream-json event type: system | assistant | user | result | … */
  type: string;
  [key: string]: unknown;
}

export interface AgentRunOptions {
  prompt: string;
  cwd?: string;
  /** Resume a previous Claude Code session (--resume). */
  sessionId?: string;
  allowedTools?: string[];
  /**
   * Model alias for this run ('haiku' | 'sonnet' | 'opus'). 'default' or unset
   * means the CLI's own default (no --model flag).
   */
  model?: string;
  timeoutMs?: number;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentRunResult {
  text: string;
  sessionId: string;
  /** Parsed JSON when the reply is (or contains) a JSON payload. */
  structured?: unknown;
  /** True when the CLI reported the run itself errored (usage limit reached,
   *  max turns, execution error) — the text is then an error notice, not an answer. */
  isError?: boolean;
  /** Raw result subtype from the CLI (e.g. 'success', 'error_max_turns'). */
  resultSubtype?: string;
}

export interface AgentRunner {
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/**
 * Pull every plausible JSON payload out of an agent reply, most-likely first:
 *  1. the whole reply parsed as JSON,
 *  2. each ```json fenced block (tolerant of missing language tag / newlines),
 *  3. each balanced {...} / [...] span found in prose (string-aware scan).
 * Models (Sonnet especially) sometimes wrap the payload in fences or prose
 * despite strict-JSON instructions — extraction must survive all of that.
 */
export function extractStructuredCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const candidate = raw.trim();
    if (!candidate || seen.has(candidate)) return;
    try {
      out.push(JSON.parse(candidate));
      seen.add(candidate);
    } catch {
      /* not JSON — skip */
    }
  };

  const trimmed = text.trim();
  if (!trimmed) return out;
  push(trimmed);

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fenceRe.exec(trimmed); m; m = fenceRe.exec(trimmed)) {
    if (m[1]) push(m[1]);
  }

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = scanBalanced(trimmed, i);
    if (end === -1) continue;
    const before = out.length;
    push(trimmed.slice(i, end + 1));
    if (out.length > before) i = end; // parsed — continue past this span
  }
  return out;
}

/** Try to pull the most likely structured JSON payload out of an agent reply. */
export function extractStructured(text: string): unknown {
  return extractStructuredCandidates(text)[0];
}

/** Index of the bracket closing the one at `start`, honoring JSON strings; -1 if unbalanced. */
function scanBalanced(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === open) {
      depth += 1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
