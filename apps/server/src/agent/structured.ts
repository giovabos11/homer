// runStructured — one-shot agent call that MUST yield schema-valid JSON.
//
// Root-cause hardening for the "returned unparseable output: … received
// undefined" pipeline failures: replies are mined for every plausible JSON
// candidate (bare / fenced / prose-embedded — see extractStructuredCandidates),
// each candidate is validated against the zod schema, and a single automatic
// corrective retry re-asks with an explicit JSON-only instruction. On final
// failure the raw reply (truncated) is embedded in the thrown error so it
// lands in the task's lastError and future debugging is trivial. CLI-reported
// run errors (usage limit reached, max turns, execution errors) surface their
// actual text instead of collapsing into a bare zod message.
import type { ZodType } from 'zod';
import { extractStructuredCandidates, type AgentRunner, type AgentRunOptions } from './types';

export const JSON_ONLY_REMINDER =
  'Respond with ONLY the JSON object, no prose, no code fences.';

const RAW_EXCERPT_CHARS = 400;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '(empty reply)';
  return flat.length > RAW_EXCERPT_CHARS ? `${flat.slice(0, RAW_EXCERPT_CHARS)}…` : flat;
}

/**
 * Run an agent prompt and parse its reply against `schema`.
 * One automatic corrective retry when the first reply cannot be parsed.
 * Throws with the truncated raw output when both attempts fail.
 */
export async function runStructured<T>(
  runner: AgentRunner,
  opts: AgentRunOptions,
  schema: ZodType<T>,
  label: string,
): Promise<T> {
  let lastRaw = '';
  let lastIssue = 'no JSON object found in the reply';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0 ? opts.prompt : `${opts.prompt}\n\n${JSON_ONLY_REMINDER}`;
    const result = await runner.run({ ...opts, prompt });
    lastRaw = result.text;
    if (result.isError) {
      lastIssue = `agent run errored (${result.resultSubtype ?? 'unknown'})`;
      continue;
    }
    const candidates = extractStructuredCandidates(result.text);
    if (result.structured !== undefined) candidates.unshift(result.structured);
    let firstSchemaIssue: string | null = null;
    for (const candidate of candidates) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) return parsed.data;
      firstSchemaIssue ??= parsed.error.issues[0]?.message ?? 'schema mismatch';
    }
    lastIssue = firstSchemaIssue ?? lastIssue;
  }
  throw new Error(
    `${label} returned unparseable output: ${lastIssue}. Raw output (truncated): ${excerpt(lastRaw)}`,
  );
}
