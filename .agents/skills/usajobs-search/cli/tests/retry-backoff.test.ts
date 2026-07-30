import { afterEach, describe, expect, test } from "bun:test";
import { apiGet } from "../src/helpers";

// The portal contract requires backoff on 429/5xx. Stubbed fetch counts
// attempts; stubbed setTimeout fires immediately.

const CREDS = { apiKey: "test-key", email: "test@example.com" };

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

function stubFetch(responses: Array<() => Response>): { calls: number; lastInit?: RequestInit } {
  const state: { calls: number; lastInit?: RequestInit } = { calls: 0 };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const i = Math.min(state.calls, responses.length - 1);
    state.calls++;
    state.lastInit = init;
    return responses[i]();
  }) as unknown as typeof fetch;
  return state;
}

describe("apiGet retry/backoff", () => {
  test("retries a 429 and succeeds, sending the auth headers", async () => {
    instantTimers();
    const state = stubFetch([
      () => new Response("", { status: 429 }),
      () => new Response('{"SearchResult":{"SearchResultItems":[]}}', { status: 200 }),
    ]);

    const data = await apiGet<{ SearchResult: unknown }>("https://data.usajobs.gov/api/search", CREDS);
    expect(data.SearchResult).toBeDefined();
    expect(state.calls).toBe(2);
    const headers = state.lastInit?.headers as Record<string, string>;
    expect(headers["Authorization-Key"]).toBe("test-key");
    expect(headers["User-Agent"]).toBe("test@example.com");
  });

  test("401 fails fast with a credentials hint, no retry", async () => {
    const state = stubFetch([() => new Response("", { status: 401 })]);

    await expect(apiGet("https://data.usajobs.gov/api/search", CREDS)).rejects.toThrow(/USAJOBS_API_KEY/);
    expect(state.calls).toBe(1);
  });

  test("gives up after the initial attempt plus six retries on persistent 5xx", async () => {
    instantTimers();
    const state = stubFetch([() => new Response("", { status: 500 })]);

    await expect(apiGet("https://data.usajobs.gov/api/search", CREDS)).rejects.toThrow(/500/);
    expect(state.calls).toBe(7);
  });
});
