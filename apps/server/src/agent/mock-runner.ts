// MockRunner — deterministic AgentRunner for tests and SIMULATE demos.
import crypto from 'node:crypto';
import { AgentAborted } from './claude-code-runner';
import { extractStructured, type AgentRunner, type AgentRunOptions, type AgentRunResult } from './types';

export type MockScript = (opts: AgentRunOptions) => { text: string; structured?: unknown } | string;

export class MockRunner implements AgentRunner {
  public calls: AgentRunOptions[] = [];

  constructor(
    private script: MockScript = (o) => `Mock response to: ${o.prompt.slice(0, 80)}`,
    private delayMs = 0,
  ) {}

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(opts);
    if (opts.signal?.aborted) throw new AgentAborted();
    const sessionId = opts.sessionId ?? crypto.randomUUID();
    opts.onEvent?.({ type: 'system', subtype: 'init', session_id: sessionId });

    const scripted = this.script(opts);
    const text = typeof scripted === 'string' ? scripted : scripted.text;
    const structured = typeof scripted === 'string' ? extractStructured(text) : (scripted.structured ?? extractStructured(text));

    // Surface the reply as streaming deltas so SSE consumers are exercised.
    const words = text.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 8) {
      const delta = words.slice(i, i + 8).join('');
      opts.onEvent?.({
        type: 'assistant',
        message: { content: [{ type: 'text', text: delta }] },
        session_id: sessionId,
      });
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      if (opts.signal?.aborted) throw new AgentAborted();
    }
    opts.onEvent?.({ type: 'result', subtype: 'success', result: text, session_id: sessionId });
    return { text, sessionId, structured };
  }
}
