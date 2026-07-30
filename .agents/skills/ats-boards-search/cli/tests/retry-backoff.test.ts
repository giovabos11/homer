import { afterEach, describe, expect, test } from "bun:test";
import { apiGet } from "../src/helpers";

// The portal contract requires backoff on 429/5xx. These tests pin the retry
// loop offline: a stubbed fetch counts attempts, and a stubbed setTimeout
// fires immediately so neither the backoff schedule nor the 500ms politeness
// spacing sleeps for real.

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
      () => new Response('{"jobs":[]}', { status: 200 }),
    ]);

    const data = await apiGet<{ jobs: unknown[] }>("https://boards-api.greenhouse.io/v1/boards/x/jobs");
    expect(data?.jobs).toEqual([]);
    expect(state.calls).toBe(2);
  });

  test("returns null on a 404 (board does not exist) without retrying", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 404 })]);

    const data = await apiGet("https://boards-api.greenhouse.io/v1/boards/x/jobs");
    expect(data).toBeNull();
    expect(state.calls).toBe(1);
  });

  test("does not retry a plain 4xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 400 })]);

    await expect(apiGet("https://api.lever.co/v0/postings/x")).rejects.toThrow(/400/);
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 500 })]);

    await expect(apiGet("https://api.ashbyhq.com/posting-api/job-board/x")).rejects.toThrow(/500/);
    expect(state.calls).toBe(7);
  });
});
