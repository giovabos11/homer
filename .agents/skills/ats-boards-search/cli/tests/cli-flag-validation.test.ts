import { describe, expect, test } from "bun:test";
import { join } from "path";
import { runCLI } from "./helpers";

// All cases either fail flag validation before any network request or run the
// sweep against an empty fixture registry, so the suite is network-free.

const EMPTY_REGISTRY = { ATS_COMPANIES_FILE: join(import.meta.dir, "fixtures", "companies-empty.json") };

function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

describe("ats-boards CLI flag validation", () => {
  for (const flag of ["jobage", "page", "limit", "batch"]) {
    test(`--${flag} with a non-numeric value exits 1 with BAD_ARG`, async () => {
      const result = await runCLI(["search", `--${flag}`, "abc"], EMPTY_REGISTRY);
      expect(result.exitCode).not.toBe(0);
      const err = parsedStderr(result.stderr);
      expect(err.code).toBe("BAD_ARG");
      expect(err.error).toMatch(new RegExp(flag));
    });
  }

  test("--ats with an unknown kind exits 1 with BAD_ARG", async () => {
    const result = await runCLI(["search", "--ats", "workday"], EMPTY_REGISTRY);
    expect(result.exitCode).not.toBe(0);
    const err = parsedStderr(result.stderr);
    expect(err.code).toBe("BAD_ARG");
    expect(err.error).toMatch(/greenhouse\|lever\|ashby/);
  });

  test("--remote with an unknown mode exits 1 with BAD_ARG", async () => {
    const result = await runCLI(["search", "--remote", "sometimes"], EMPTY_REGISTRY);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ARG");
  });

  test("detail without an id exits 1 with NO_ID", async () => {
    const result = await runCLI(["detail"], EMPTY_REGISTRY);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("NO_ID");
  });

  test("detail with an unparseable reference exits 1 with BAD_ID", async () => {
    const result = await runCLI(["detail", "not-a-job-ref"], EMPTY_REGISTRY);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ID");
  });

  test("unknown command exits 1 with BAD_CMD", async () => {
    const result = await runCLI(["frobnicate"], EMPTY_REGISTRY);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_CMD");
  });

  test("valid flags against an empty registry emit the contract envelope offline", async () => {
    const result = await runCLI(
      ["search", "-q", "engineer", "--jobage", "7", "--page", "1", "--limit", "5"],
      EMPTY_REGISTRY,
    );
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.meta.count).toBe(0);
    expect(out.meta.page).toBe(1);
    expect(out.results).toEqual([]);
  });
});
