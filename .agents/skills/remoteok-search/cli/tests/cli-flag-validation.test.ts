import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { runCLI } from "./helpers";

// Validation failures exit before any network request. The "valid flags" case
// runs against a freshly-written cache fixture, so the whole suite is
// network-free.

function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

async function freshCache(): Promise<Record<string, string>> {
  const path = join(tmpdir(), `remoteok-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await Bun.write(
    path,
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      jobs: [
        {
          id: "42",
          slug: "remote-react-engineer-acme-42",
          position: "React Engineer",
          company: "Acme",
          location: "United States",
          tags: ["dev", "react"],
          date: new Date().toISOString(),
          url: "https://remoteok.com/remote-jobs/remote-react-engineer-acme-42",
          description: "<p>React + TypeScript</p>",
          salary_min: 100000,
          salary_max: 150000,
        },
      ],
    }),
  );
  return { REMOTEOK_CACHE_FILE: path };
}

describe("RemoteOK CLI flag validation", () => {
  for (const flag of ["jobage", "page", "limit"]) {
    test(`--${flag} with a non-numeric value exits 1 with BAD_ARG`, async () => {
      const result = await runCLI(["search", `--${flag}`, "abc"]);
      expect(result.exitCode).not.toBe(0);
      const err = parsedStderr(result.stderr);
      expect(err.code).toBe("BAD_ARG");
      expect(err.error).toMatch(new RegExp(flag));
    });
  }

  test("detail without an id exits 1 with NO_ID", async () => {
    const result = await runCLI(["detail"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("NO_ID");
  });

  test("unknown command exits 1 with BAD_CMD", async () => {
    const result = await runCLI(["frobnicate"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_CMD");
  });

  test("valid flags emit the contract envelope from a fresh cache (offline)", async () => {
    const env = await freshCache();
    const result = await runCLI(["search", "-q", "react", "--jobage", "7", "--page", "1", "--limit", "5"], env);
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.meta.count).toBe(1);
    expect(out.meta.page).toBe(1);
    expect(out.meta.cached).toBe(true);
    expect(out.results[0].id).toBe("42");
    expect(out.results[0].salary_currency).toBe("USD");
  });

  test("detail resolves from the cache offline", async () => {
    const env = await freshCache();
    const result = await runCLI(["detail", "42"], env);
    expect(result.exitCode).toBe(0);
    const job = JSON.parse(result.stdout);
    expect(job.title).toBe("React Engineer");
    expect(job.description).toContain("React + TypeScript");
  });

  test("detail for an unknown id exits 1 with NOT_FOUND (offline via cache)", async () => {
    const env = await freshCache();
    const result = await runCLI(["detail", "999999"], env);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("NOT_FOUND");
  });
});
