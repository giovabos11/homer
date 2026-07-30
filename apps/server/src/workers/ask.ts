// Ask-anything worker (FR-29). REAL: streams an AgentRunner session (Claude
// Code headless in the repo root, so CLAUDE.md + profile skills auto-load as
// context) and forwards deltas to the dashboard as ask.delta SSE events.
// With SIMULATE=1 (or when the Claude CLI is absent) the MockRunner streams a
// canned reply through the same path.
import type { Worker, WorkerArgs } from './registry';

export const askWorker: Worker = {
  type: 'ask',
  async run({ ctx, task }: WorkerArgs): Promise<void> {
    const payload = JSON.parse(task.payloadJson) as { requestId?: string; prompt?: string; sessionId?: string };
    const requestId = payload.requestId ?? String(task.id);
    const prompt = payload.prompt ?? '';
    if (!prompt) return;

    let streamed = '';
    const result = await ctx.runner.run({
      prompt,
      cwd: ctx.repoRoot,
      sessionId: payload.sessionId,
      timeoutMs: ctx.config.agent.defaultTimeoutMs,
      onEvent: (e) => {
        if (e.type !== 'assistant') return;
        const message = e.message as { content?: { type?: string; text?: string }[] } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            streamed += block.text;
            ctx.bus.emit({ type: 'ask.delta', requestId, delta: block.text, done: false });
          }
        }
      },
    });

    // If the runner produced a final text that streaming missed, send the remainder.
    if (result.text && result.text.length > streamed.length && result.text.startsWith(streamed)) {
      ctx.bus.emit({ type: 'ask.delta', requestId, delta: result.text.slice(streamed.length), done: false });
    }
    ctx.bus.emit({ type: 'ask.delta', requestId, delta: '', done: true });
  },
};
