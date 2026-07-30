import { afterEach, describe, expect, test } from "bun:test";
import { fetchFeed } from "../src/helpers";

// A stalled connection would otherwise hang the CLI forever - fetch has no
// default timeout. Assert the request wrapper carries an AbortSignal timeout.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchFeed request timeout", () => {
  test("passes an AbortSignal timeout to fetch", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await fetchFeed();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
