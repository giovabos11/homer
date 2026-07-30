import { afterEach, describe, expect, test } from "bun:test";
import { apiGet } from "../src/helpers";

// The portal contract requires backoff on 429/5xx. Stubbed fetch counts
// attempts; stubbed setTimeout fires immediately.

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function instantTimers() {
  globalThis.setTimeout = ((fn: () => void) =>
    originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
}

function stubFetch(responses: Array<() => Response>): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const i = Math.min(state.calls, responses.length - 1);
    state.calls++;
    return responses[i]();
  }) as unknown as typeof fetch;
  return state;
}

describe("apiGet retry/backoff", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response('{"results":[]}', { status: 200 }),
    ]);

    const data = await apiGet<{ results: unknown[] }>("https://api.adzuna.com/v1/api/jobs/us/search/1");
    expect(data.results).toEqual([]);
    expect(state.calls).toBe(2);
  });

  test("401 fails fast with a credentials hint, no retry", async () => {
    const state = stubFetch([() => new Response("", { status: 401 })]);

    await expect(apiGet("https://api.adzuna.com/v1/api/jobs/us/search/1")).rejects.toThrow(/ADZUNA_APP_ID/);
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 500 })]);

    await expect(apiGet("https://api.adzuna.com/v1/api/jobs/us/search/1")).rejects.toThrow(/500/);
    expect(state.calls).toBe(7);
  });
});
