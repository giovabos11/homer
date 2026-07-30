import { afterEach, describe, expect, test } from "bun:test";
import { apiGet } from "../src/helpers";

// A stalled upstream connection (accepted socket, no response) would otherwise
// hang the sweep forever - fetch has no default timeout. Assert the request
// wrapper carries an AbortSignal timeout.

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

describe("apiGet request timeout", () => {
  test("passes an AbortSignal timeout to fetch", async () => {
    globalThis.setTimeout = ((fn: () => void) =>
      originalSetTimeout(fn, 0)) as unknown as typeof setTimeout;
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response('{"jobs":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await apiGet("https://boards-api.greenhouse.io/v1/boards/x/jobs");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
