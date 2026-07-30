import { describe, expect, test } from "bun:test";
import {
  headerLine,
  htmlToText,
  parseComment,
  parseRemoteType,
  parseSalary,
  type HNComment,
} from "../src/helpers";
import { applyFilters, type SearchOpts } from "../src/commands/search";
import { normalizeId } from "../src/commands/detail";

// A realistic whoishiring comment: pipe-separated header in a <p>-less HTML
// body with entity-encoded text, followed by paragraphs.
const COMMENT: HNComment = {
  id: 48747990,
  author: "hiring_manager",
  created_at: "2026-07-01T16:20:00.000Z",
  text:
    "Acme Robotics (YC W24) | Senior Full-Stack Engineer | REMOTE (US) | $150k-$200k + equity<p>We build robots &amp; tooling. Stack: React, TypeScript, Node.</p><p>Apply: jobs@acme.example</p>",
};

const ONSITE_COMMENT: HNComment = {
  id: 48748001,
  author: "founder",
  created_at: "2026-07-02T10:00:00.000Z",
  text: "Initech - Backend Developer - Austin, TX - ONSITE<p>Python, FastAPI, Postgres.</p>",
};

function opts(partial: Partial<SearchOpts>): SearchOpts {
  return {
    query: undefined,
    location: undefined,
    remote: undefined,
    thread: undefined,
    jobage: 9999,
    page: 1,
    limit: 25,
    format: "json",
    ...partial,
  };
}

describe("parseComment", () => {
  test("parses the pipe-separated header convention", () => {
    const r = parseComment(COMMENT);
    expect(r.id).toBe("48747990");
    expect(r.company).toBe("Acme Robotics (YC W24)");
    expect(r.title).toBe("Senior Full-Stack Engineer");
    expect(r.remote_type).toBe("remote");
    expect(r.salary_min).toBe(150000);
    expect(r.salary_max).toBe(200000);
    expect(r.salary_currency).toBe("USD");
    expect(r.date).toBe("2026-07-01");
    expect(r.url).toBe("https://news.ycombinator.com/item?id=48747990");
    expect(r.description).toContain("We build robots & tooling.");
  });

  test("falls back to dash-separated headers", () => {
    const r = parseComment(ONSITE_COMMENT);
    expect(r.company).toBe("Initech");
    expect(r.title).toBe("Backend Developer");
    expect(r.location).toBe("Austin, TX");
    expect(r.remote_type).toBe("onsite");
    expect(r.salary_min).toBeNull();
  });

  test("a header-less comment still yields a usable row", () => {
    const r = parseComment({ id: 1, author: null, created_at: null, text: "We are hiring, email us." });
    expect(r.id).toBe("1");
    expect(r.title).toBe("We are hiring, email us.");
    expect(r.date).toBeNull();
  });
});

describe("parseSalary", () => {
  test("k-range with dollar sign", () => {
    expect(parseSalary("$150k-$200k")).toEqual({ salary_min: 150000, salary_max: 200000, salary_currency: "USD" });
  });

  test("comma-thousands range", () => {
    expect(parseSalary("$150,000 - $200,000")).toEqual({
      salary_min: 150000,
      salary_max: 200000,
      salary_currency: "USD",
    });
  });

  test("bare k-range without $ parses when annual-sized (common in headers)", () => {
    expect(parseSalary("Full-time | 70k - 90k | 3+ YOE")).toEqual({
      salary_min: 70000,
      salary_max: 90000,
      salary_currency: "USD",
    });
  });

  test("bare k-ranges outside the 30k-900k band are not salaries", () => {
    expect(parseSalary("serving 10k-20k users")).toEqual({ salary_min: null, salary_max: null, salary_currency: null });
  });

  test("no salary text stays null", () => {
    expect(parseSalary("competitive comp")).toEqual({ salary_min: null, salary_max: null, salary_currency: null });
  });
});

describe("parseRemoteType", () => {
  test("header keyword wins; hybrid and onsite variants map correctly", () => {
    expect(parseRemoteType("X | REMOTE", "")).toBe("remote");
    expect(parseRemoteType("X | Hybrid (NYC)", "")).toBe("hybrid");
    expect(parseRemoteType("X | ON-SITE", "")).toBe("onsite");
    expect(parseRemoteType("X | In-person", "")).toBe("onsite");
    expect(parseRemoteType("X | Y", "no such keywords")).toBeNull();
  });
});

describe("filters", () => {
  const rows = [parseComment(COMMENT), parseComment(ONSITE_COMMENT)];

  test("--query matches full text", () => {
    expect(applyFilters(rows, opts({ query: "fastapi" })).map((r) => r.id)).toEqual(["48748001"]);
    expect(applyFilters(rows, opts({ query: "react typescript" })).map((r) => r.id)).toEqual(["48747990"]);
  });

  test("--remote filters by parsed workplace type", () => {
    expect(applyFilters(rows, opts({ remote: "remote" })).map((r) => r.id)).toEqual(["48747990"]);
    expect(applyFilters(rows, opts({ remote: "onsite" })).map((r) => r.id)).toEqual(["48748001"]);
  });

  test("--location matches the parsed location", () => {
    expect(applyFilters(rows, opts({ location: "austin" })).map((r) => r.id)).toEqual(["48748001"]);
  });
});

describe("small helpers", () => {
  test("headerLine takes the first text line", () => {
    expect(headerLine("a | b\nrest")).toBe("a | b");
  });

  test("htmlToText converts <p> to breaks and decodes entities", () => {
    expect(htmlToText("one<p>two &amp; three</p>")).toBe("one\ntwo & three");
    expect(htmlToText(null)).toBeNull();
  });

  test("normalizeId accepts ids and item URLs", () => {
    expect(normalizeId("48747990")).toBe("48747990");
    expect(normalizeId("https://news.ycombinator.com/item?id=48747990")).toBe("48747990");
    expect(normalizeId("nope")).toBeNull();
  });
});
