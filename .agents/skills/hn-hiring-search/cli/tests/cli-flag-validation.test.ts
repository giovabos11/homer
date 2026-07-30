import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { runCLI } from "./helpers";

// Validation failures exit before any network request. The "valid flags" case
// runs against a freshly-written cache fixture (latest-thread pointer +
// thread comments), so the whole suite is network-free.

function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

async function freshCache(): Promise<Record<string, string>> {
  const path = join(tmpdir(), `hn-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const now = new Date().toISOString();
  await Bun.write(
    path,
    JSON.stringify({
      latest: { checked_at: now, id: "111", title: "Ask HN: Who is hiring? (July 2026)" },
      threads: {
        "111": {
          fetched_at: now,
          title: "Ask HN: Who is hiring? (July 2026)",
          comments: [
            {
              id: 222,
              author: "poster",
              created_at: now,
              text: "Acme | React Engineer | REMOTE (US) | $140k-$180k<p>React and TypeScript.</p>",
            },
          ],
        },
      },
    }),
  );
  return { HN_CACHE_FILE: path };
}

describe("HN hiring CLI flag validation", () => {
  for (const flag of ["jobage", "page", "limit"]) {
    test(`--${flag} with a non-numeric value exits 1 with BAD_ARG`, async () => {
      const result = await runCLI(["search", `--${flag}`, "abc"]);
      expect(result.exitCode).not.toBe(0);
      const err = parsedStderr(result.stderr);
      expect(err.code).toBe("BAD_ARG");
      expect(err.error).toMatch(new RegExp(flag));
    });
  }

  test("--remote with an unknown mode exits 1 with BAD_ARG", async () => {
    const result = await runCLI(["search", "--remote", "sometimes"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ARG");
  });

  test("--thread with a non-numeric id exits 1 with BAD_ARG", async () => {
    const result = await runCLI(["search", "--thread", "latest-please"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ARG");
  });

  test("detail without an id exits 1 with NO_ID", async () => {
    const result = await runCLI(["detail"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("NO_ID");
  });

  test("detail with an unparseable id exits 1 with BAD_ID", async () => {
    const result = await runCLI(["detail", "not-an-id"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ID");
  });

  test("unknown command exits 1 with BAD_CMD", async () => {
    const result = await runCLI(["frobnicate"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_CMD");
  });

  test("valid flags emit the contract envelope from a fresh cache (offline)", async () => {
    const env = await freshCache();
    const result = await runCLI(["search", "-q", "react", "--remote", "--jobage", "40", "--limit", "5"], env);
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.meta.count).toBe(1);
    expect(out.meta.page).toBe(1);
    expect(out.meta.thread_id).toBe("111");
    expect(out.meta.cached).toBe(true);
    expect(out.results[0].id).toBe("222");
    expect(out.results[0].company).toBe("Acme");
    expect(out.results[0].salary_min).toBe(140000);
    // Search rows carry a snippet, not the full description.
    expect(out.results[0].snippet).toContain("React and TypeScript");
    expect(out.results[0].description).toBeUndefined();
  });
});
