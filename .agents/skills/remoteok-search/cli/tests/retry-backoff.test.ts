import { afterEach, describe, expect, test } from "bun:test";
import { fetchFeed } from "../src/helpers";

// The portal contract requires backoff on 429/5xx. Stubbed fetch counts
// attempts; stubbed setTimeout fires immediately so the exhaustion case does
// not sleep through the real backoff schedule.

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

describe("fetchFeed retry/backoff", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response("[]", { status: 200 }),
    ]);

    const feed = await fetchFeed();
    expect(feed).toEqual([]);
    expect(state.calls).toBe(2);
  });

  test("does not retry a plain 4xx", async () => {
    const state = stubFetch([() => new Response("", { status: 403 })]);

    await expect(fetchFeed()).rejects.toThrow(/403/);
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 503 })]);

    await expect(fetchFeed()).rejects.toThrow(/503/);
    expect(state.calls).toBe(7);
  });

  test("a non-array body is surfaced as an error, not silently emptied", async () => {
    stubFetch([() => new Response('{"oops":true}', { status: 200 })]);
    await expect(fetchFeed()).rejects.toThrow(/not a JSON array/);
  });
});
