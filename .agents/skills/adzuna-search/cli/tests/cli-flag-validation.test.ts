import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { runCLI } from "./helpers";

// Everything here is network-free: flag validation and the missing-key guard
// exit before any request, and detail answers from a written cache fixture.

const NO_KEYS = { ADZUNA_APP_ID: "", ADZUNA_APP_KEY: "" };

function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

async function cacheWithJob(): Promise<Record<string, string>> {
  const path = join(tmpdir(), `adzuna-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await Bun.write(
    path,
    JSON.stringify({
      jobs: {
        "42": {
          cached_at: new Date().toISOString(),
          job: {
            id: 42,
            title: "React Engineer",
            company: { display_name: "Acme" },
            location: { display_name: "Dallas" },
            created: "2026-07-20T00:00:00Z",
            redirect_url: "https://www.adzuna.com/land/ad/42",
            salary_min: 120000,
            salary_max: 150000,
            salary_is_predicted: "0",
            description: "React work in Dallas.",
          },
        },
      },
    }),
  );
  return { ADZUNA_CACHE_FILE: path, ...NO_KEYS };
}

describe("Adzuna CLI flag validation & key guard", () => {
  for (const flag of ["jobage", "page", "limit"]) {
    test(`--${flag} with a non-numeric value exits 1 with BAD_ARG`, async () => {
      const result = await runCLI(["search", `--${flag}`, "abc"], NO_KEYS);
      expect(result.exitCode).not.toBe(0);
      const err = parsedStderr(result.stderr);
      expect(err.code).toBe("BAD_ARG");
      expect(err.error).toMatch(new RegExp(flag));
    });
  }

  test("search without credentials exits 1 with MISSING_API_KEY and setup instructions", async () => {
    const result = await runCLI(["search", "-q", "react"], NO_KEYS);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    const err = parsedStderr(result.stderr);
    expect(err.code).toBe("MISSING_API_KEY");
    expect(err.error).toContain("developer.adzuna.com");
    expect(err.error).toContain("ADZUNA_APP_ID");
  });

  test("detail without an id exits 1 with NO_ID", async () => {
    const result = await runCLI(["detail"], NO_KEYS);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("NO_ID");
  });

  test("detail with an unparseable id exits 1 with BAD_ID", async () => {
    const result = await runCLI(["detail", "not-an-id"], NO_KEYS);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ID");
  });

  test("unknown command exits 1 with BAD_CMD", async () => {
    const result = await runCLI(["frobnicate"], NO_KEYS);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_CMD");
  });

  test("detail resolves offline from the search cache (no key required)", async () => {
    const env = await cacheWithJob();
    const result = await runCLI(["detail", "42"], env);
    expect(result.exitCode).toBe(0);
    const job = JSON.parse(result.stdout);
    expect(job.title).toBe("React Engineer");
    expect(job.salary_min).toBe(120000);
    expect(job.description).toBe("React work in Dallas.");
  });

  test("detail for a never-cached id exits 1 with NOT_CACHED", async () => {
    const env = await cacheWithJob();
    const result = await runCLI(["detail", "999999"], env);
    expect(result.exitCode).not.toBe(0);
    const err = parsedStderr(result.stderr);
    expect(err.code).toBe("NOT_CACHED");
    expect(err.error).toContain("run a search");
  });
});
