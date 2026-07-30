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
}

export interface AgentRunner {
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}

/** Try to pull a structured JSON payload out of an agent reply. */
export function extractStructured(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* not bare JSON */
  }
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/m.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* not fenced JSON either */
    }
  }
  return undefined;
}
