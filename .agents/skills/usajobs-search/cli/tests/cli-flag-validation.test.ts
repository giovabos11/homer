import { describe, expect, test } from "bun:test";
import { runCLI } from "./helpers";

// Everything here is network-free: flag validation and the missing-key guard
// exit before any request is made.

const NO_KEYS = { USAJOBS_API_KEY: "", USAJOBS_EMAIL: "" };

function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

describe("USAJOBS CLI flag validation & key guard", () => {
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
    const result = await runCLI(["search", "-q", "software"], NO_KEYS);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    const err = parsedStderr(result.stderr);
    expect(err.code).toBe("MISSING_API_KEY");
    expect(err.error).toContain("developer.usajobs.gov");
    expect(err.error).toContain("USAJOBS_API_KEY");
    expect(err.error).toContain("USAJOBS_EMAIL");
  });

  test("a key without the email still fails the guard (both are required)", async () => {
    const result = await runCLI(["search", "-q", "software"], { USAJOBS_API_KEY: "k", USAJOBS_EMAIL: "" });
    expect(result.exitCode).toBe(1);
    expect(parsedStderr(result.stderr).code).toBe("MISSING_API_KEY");
  });

  test("detail without credentials exits 1 with MISSING_API_KEY", async () => {
    const result = await runCLI(["detail", "834567800"], NO_KEYS);
    expect(result.exitCode).toBe(1);
    expect(parsedStderr(result.stderr).code).toBe("MISSING_API_KEY");
  });

  test("detail without an id exits 1 with NO_ID", async () => {
    const result = await runCLI(["detail"], NO_KEYS);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("NO_ID");
  });

  test("detail with an unparseable id exits 1 with BAD_ID", async () => {
    const result = await runCLI(["detail", "not an id!"], NO_KEYS);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ID");
  });

  test("unknown command exits 1 with BAD_CMD", async () => {
    const result = await runCLI(["frobnicate"], NO_KEYS);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_CMD");
  });
});
