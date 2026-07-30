// Structured-output extraction hardening: Sonnet (and error paths like usage
// limits) may wrap or replace the JSON payload — extraction must survive
// fences, prose, embedded fragments, and CLI-reported run errors, with one
// corrective retry and the raw reply preserved in the final error.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractStructured, extractStructuredCandidates, type AgentRunOptions, type AgentRunResult, type AgentRunner } from '../src/agent/types';
import { runStructured, JSON_ONLY_REMINDER } from '../src/agent/structured';

describe('extractStructured', () => {
  it('parses a clean bare JSON object', () => {
    expect(extractStructured('{"a": 1, "b": [2, 3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('parses a ```json fenced block', () => {
    expect(extractStructured('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('parses a fenced block without a newline before the closing fence', () => {
    expect(extractStructured('```json\n{"a": 1}```')).toEqual({ a: 1 });
  });

  it('parses a fence with no language tag', () => {
    expect(extractStructured('```\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  it('pulls the object out of surrounding prose', () => {
    const text = 'Here is my evaluation of the posting:\n{"technical": 80, "notes": "solid"}\nLet me know if you need more.';
    expect(extractStructured(text)).toEqual({ technical: 80, notes: 'solid' });
  });

  it('skips non-JSON brace fragments (schema descriptions) and finds the real payload', () => {
    const text = 'The shape is { "technical": number } as requested.\n\n{"technical": 55}';
    const candidates = extractStructuredCandidates(text);
    expect(candidates).toContainEqual({ technical: 55 });
  });

  it('handles braces inside JSON strings', () => {
    const text = 'Result: {"note": "uses {curly} braces and a \\" quote", "ok": true} done';
    expect(extractStructured(text)).toEqual({ note: 'uses {curly} braces and a " quote', ok: true });
  });

  it('returns undefined for empty or JSON-free replies', () => {
    expect(extractStructured('')).toBeUndefined();
    expect(extractStructured('   ')).toBeUndefined();
    expect(extractStructured('Claude usage limit reached. Try again later.')).toBeUndefined();
  });
});

/** Minimal scripted runner: returns queued replies in order. */
function fakeRunner(replies: Partial<AgentRunResult>[]): { runner: AgentRunner; calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  const runner: AgentRunner = {
    async run(opts) {
      calls.push(opts);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
      const text = reply.text ?? '';
      return { text, sessionId: 's', structured: reply.structured ?? extractStructured(text), isError: reply.isError, resultSubtype: reply.resultSubtype };
    },
  };
  return { runner, calls };
}

const schema = z.object({ score: z.number() });

describe('runStructured', () => {
  it('returns the parsed payload on a clean first reply (no retry)', async () => {
    const { runner, calls } = fakeRunner([{ text: '{"score": 88}' }]);
    const data = await runStructured(runner, { prompt: 'p' }, schema, 'Test agent');
    expect(data).toEqual({ score: 88 });
    expect(calls.length).toBe(1);
  });

  it('retries once with a JSON-only reminder when the first reply has no JSON', async () => {
    const { runner, calls } = fakeRunner([
      { text: 'Sure! I evaluated the posting and it looks decent overall.' },
      { text: '```json\n{"score": 42}\n```' },
    ]);
    const data = await runStructured(runner, { prompt: 'base prompt' }, schema, 'Test agent');
    expect(data).toEqual({ score: 42 });
    expect(calls.length).toBe(2);
    expect(calls[0]!.prompt).toBe('base prompt');
    expect(calls[1]!.prompt).toContain(JSON_ONLY_REMINDER);
  });

  it('fails with the truncated raw output in the error after both attempts', async () => {
    const { runner, calls } = fakeRunner([{ text: 'Claude usage limit reached|1785465000' }]);
    await expect(runStructured(runner, { prompt: 'p' }, schema, 'Score agent')).rejects.toThrow(
      /Score agent returned unparseable output: .*Raw output \(truncated\): Claude usage limit reached/,
    );
    expect(calls.length).toBe(2);
  });

  it('reports schema mismatches (parseable JSON, wrong shape) with the raw reply', async () => {
    const { runner } = fakeRunner([{ text: '{"score": "high"}' }]);
    await expect(runStructured(runner, { prompt: 'p' }, schema, 'Score agent')).rejects.toThrow(
      /Score agent returned unparseable output: .*Raw output \(truncated\): \{"score": "high"\}/,
    );
  });

  it('treats CLI-reported run errors as unparseable and surfaces their text', async () => {
    const { runner } = fakeRunner([
      { text: '5-hour limit reached · resets 3am', isError: true, resultSubtype: 'success' },
    ]);
    await expect(runStructured(runner, { prompt: 'p' }, schema, 'Score agent')).rejects.toThrow(
      /agent run errored.*Raw output \(truncated\): 5-hour limit reached/,
    );
  });

  it('recovers when the wrong balanced object comes first but a later candidate fits the schema', async () => {
    const text = 'Summary: {"verdict": "legit"} — full result: {"score": 71}';
    const { runner, calls } = fakeRunner([{ text }]);
    const data = await runStructured(runner, { prompt: 'p' }, schema, 'Test agent');
    expect(data).toEqual({ score: 71 });
    expect(calls.length).toBe(1);
  });
});
