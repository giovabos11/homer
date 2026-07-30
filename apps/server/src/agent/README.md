# AgentRunner — the AI engine seam

All AI work in the server goes through one interface (`src/agent/types.ts`):

```ts
interface AgentRunner {
  run(opts: {
    prompt: string; cwd?: string; sessionId?: string;
    allowedTools?: string[]; timeoutMs?: number;
    onEvent?: (e: AgentEvent) => void;
  }): Promise<{ text: string; sessionId: string; structured?: unknown }>;
}
```

## Default implementation: `ClaudeCodeRunner`

Spawns `claude -p --output-format stream-json --verbose` with `cwd` = repo root,
parses the NDJSON event stream, forwards every event through `onEvent`, and
returns the final result text plus the `session_id` (pass it back as
`sessionId` to continue a conversation via `--resume`).

Two hard rules (PRD D6):

1. **`ANTHROPIC_API_KEY` is deleted from the child environment.** The user's
   Claude subscription OAuth login must be the auth path; a stray API key in the
   environment would silently switch billing to pay-per-token.
2. **`--bare` is never passed.** It would bypass the OAuth login flow.

The prompt is written to **stdin**, never embedded in argv, so Windows
`.cmd`-shim quoting can never mangle it (and nothing user-controlled ever
reaches a shell).

## Swapping the provider later

Two seams, pick either:

1. **Gateway swap (no code change).** Claude Code honors `ANTHROPIC_BASE_URL`.
   Point it at a [LiteLLM](https://docs.litellm.ai/) proxy (or any
   Anthropic-compatible gateway) and set the gateway's key:

   ```
   ANTHROPIC_BASE_URL=http://localhost:4000   # LiteLLM proxy
   ANTHROPIC_AUTH_TOKEN=<gateway key>
   ```

   LiteLLM then routes to OpenAI / Gemini / local models while the server keeps
   spawning the same CLI. Note: `ClaudeCodeRunner` deletes only
   `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are
   passed through untouched, which is what makes this swap work.

2. **Runner swap (new class).** Implement `AgentRunner` against any SDK
   (OpenAI, Gemini, a local llama.cpp server, …) and inject it where the
   context is built (`src/context.ts`). `MockRunner` in `mock-runner.ts` is the
   reference implementation of the interface — tests and `SIMULATE=1` demos use it.

## Session continuation

`run()` returns the `sessionId` extracted from the stream. Pass it back in the
next call to continue with full context (`--resume <id>` under the hood). The
ask-anything worker uses this to keep a rolling conversation per request chain.
