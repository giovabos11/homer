import { afterEach, describe, expect, test } from "bun:test";
import { fetchFeed } from "../src/helpers";

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

describe("fetchFeed retry/backoff", () => {
  test("retries a 429 and succeeds on the next attempt", async () => {
    instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response("<rss></rss>", { status: 200 }),
    ]);

    const xml = await fetchFeed("https://weworkremotely.com/remote-jobs.rss");
    expect(xml).toContain("rss");
    expect(state.calls).toBe(2);
  });

  test("does not retry a plain 4xx", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);

    await expect(fetchFeed("https://weworkremotely.com/remote-jobs.rss")).rejects.toThrow(/404/);
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 500 })]);

    await expect(fetchFeed("https://weworkremotely.com/remote-jobs.rss")).rejects.toThrow(/500/);
    expect(state.calls).toBe(7);
  });
});
