import { afterEach, describe, expect, test } from "bun:test";
import { fetchCategory } from "../src/helpers";

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

describe("fetchCategory retry/backoff", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response('{"jobs":[]}', { status: 200 }),
    ]);

    const jobs = await fetchCategory("software-dev");
    expect(jobs).toEqual([]);
    expect(state.calls).toBe(2);
  });

  test("does not retry a plain 4xx", async () => {
    const state = stubFetch([() => new Response("", { status: 400 })]);

    await expect(fetchCategory("software-dev")).rejects.toThrow(/400/);
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 502 })]);

    await expect(fetchCategory("software-dev")).rejects.toThrow(/502/);
    expect(state.calls).toBe(7);
  });

  test("a body without a jobs array is surfaced as an error", async () => {
    stubFetch([() => new Response('{"nope":1}', { status: 200 })]);
    await expect(fetchCategory("software-dev")).rejects.toThrow(/jobs array/);
  });
});
