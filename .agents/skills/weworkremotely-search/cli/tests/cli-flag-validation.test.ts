import { describe, expect, test } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { runCLI } from "./helpers";

// Validation failures exit before any network request. The "valid flags" cases
// run against a freshly-written cache fixture, so the whole suite is network-free.

function parsedStderr(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

async function freshCache(): Promise<Record<string, string>> {
  const path = join(tmpdir(), `wwr-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const item = {
    id: "acme-react-engineer",
    company: "Acme",
    title: "React Engineer",
    region: "USA Only",
    category: "Front-End Programming",
    date: new Date().toISOString().slice(0, 10),
    url: "https://weworkremotely.com/remote-jobs/acme-react-engineer",
    descriptionHtml: "<p>React work</p>",
  };
  await Bun.write(
    path,
    JSON.stringify({
      categories: {
        programming: { fetched_at: new Date().toISOString(), items: [item] },
        all: { fetched_at: new Date().toISOString(), items: [item] },
      },
    }),
  );
  return { WWR_CACHE_FILE: path };
}

describe("WWR CLI flag validation", () => {
  for (const flag of ["jobage", "page", "limit"]) {
    test(`--${flag} with a non-numeric value exits 1 with BAD_ARG`, async () => {
      const result = await runCLI(["search", `--${flag}`, "abc"]);
      expect(result.exitCode).not.toBe(0);
      const err = parsedStderr(result.stderr);
      expect(err.code).toBe("BAD_ARG");
      expect(err.error).toMatch(new RegExp(flag));
    });
  }

  test("--category outside the feed map exits 1 with BAD_ARG", async () => {
    const result = await runCLI(["search", "--category", "gardening"]);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("BAD_ARG");
  });

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
    const result = await runCLI(["search", "-q", "react", "-l", "usa", "--jobage", "7", "--limit", "5"], env);
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.meta.count).toBe(1);
    expect(out.meta.page).toBe(1);
    expect(out.meta.cached).toBe(true);
    expect(out.results[0].id).toBe("acme-react-engineer");
    expect(out.results[0].remote_type).toBe("remote");
  });

  test("detail resolves from the cache offline", async () => {
    const env = await freshCache();
    const result = await runCLI(["detail", "acme-react-engineer"], env);
    expect(result.exitCode).toBe(0);
    const job = JSON.parse(result.stdout);
    expect(job.title).toBe("React Engineer");
    expect(job.description).toBe("React work");
  });

  test("detail for an unknown slug exits 1 with NOT_FOUND (offline via cache)", async () => {
    const env = await freshCache();
    const result = await runCLI(["detail", "no-such-job"], env);
    expect(result.exitCode).not.toBe(0);
    expect(parsedStderr(result.stderr).code).toBe("NOT_FOUND");
  });
});
