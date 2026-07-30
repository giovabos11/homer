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
      () => new Response('{"hits":[]}', { status: 200 }),
    ]);

    const data = await apiGet<{ hits: unknown[] }>("https://hn.algolia.com/api/v1/search_by_date");
    expect(data?.hits).toEqual([]);
    expect(state.calls).toBe(2);
  });

  test("returns null on a 404 without retrying", async () => {
    const state = stubFetch([() => new Response("", { status: 404 })]);

    const data = await apiGet("https://hn.algolia.com/api/v1/items/0");
    expect(data).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("does not retry a plain 4xx", async () => {
    const state = stubFetch([() => new Response("", { status: 400 })]);

    await expect(apiGet("https://hn.algolia.com/api/v1/items/x")).rejects.toThrow(/400/);
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 503 })]);

    await expect(apiGet("https://hn.algolia.com/api/v1/items/1")).rejects.toThrow(/503/);
    expect(state.calls).toBe(7);
  });
});
