import { describe, expect, test } from "bun:test";
import {
  htmlToText,
  jobMatchesQuery,
  matchesLocation,
  parseSalaryString,
  toDetail,
  toResult,
  type RemotiveJob,
} from "../src/helpers";
import { normalizeId } from "../src/commands/detail";

const WIRE: RemotiveJob = {
  id: 2090903,
  url: "https://remotive.com/remote-jobs/software-dev/senior-react-engineer-2090903",
  title: "Senior React Engineer",
  company_name: "Acme",
  category: "Software Development",
  tags: ["react", "typescript"],
  job_type: "full_time",
  publication_date: "2026-07-26T20:49:11",
  candidate_required_location: "USA",
  salary: "$130,000 - $160,000/yr",
  description: "<p>Ship UI &amp; APIs</p><ul><li>React</li><li>Node</li></ul>",
};

describe("parseSalaryString", () => {
  test("parses dollar ranges with commas", () => {
    expect(parseSalaryString("$130,000 - $160,000/yr")).toEqual({
      salary_min: 130000,
      salary_max: 160000,
      salary_currency: "USD",
    });
  });

  test("parses k-suffixed ranges", () => {
    expect(parseSalaryString("$140k-$180k")).toEqual({
      salary_min: 140000,
      salary_max: 180000,
      salary_currency: "USD",
    });
  });

  test("hourly rates never become annual salary numbers", () => {
    expect(parseSalaryString("$18 - $22/hr")).toEqual({
      salary_min: null,
      salary_max: null,
      salary_currency: null,
    });
  });

  test("empty/absent salary is all-null", () => {
    expect(parseSalaryString("")).toEqual({ salary_min: null, salary_max: null, salary_currency: null });
    expect(parseSalaryString(undefined)).toEqual({ salary_min: null, salary_max: null, salary_currency: null });
  });

  test("euro currency is detected", () => {
    expect(parseSalaryString("€50k - €70k").salary_currency).toBe("EUR");
  });
});

describe("toResult / toDetail", () => {
  test("maps the wire shape into the portal contract", () => {
    const r = toResult(WIRE);
    expect(r.id).toBe("2090903");
    expect(r.company).toBe("Acme");
    expect(r.location).toBe("USA");
    expect(r.date).toBe("2026-07-26");
    expect(r.remote_type).toBe("remote");
    expect(r.salary_min).toBe(130000);
    expect(r.salary_max).toBe(160000);
    expect(r.salary_raw).toBe("$130,000 - $160,000/yr");
  });

  test("detail converts the HTML description to text", () => {
    expect(toDetail(WIRE).description).toBe("Ship UI & APIs\nReact\nNode");
  });
});

describe("matchesLocation", () => {
  test("US-flavored wants match USA, Worldwide, and Americas postings", () => {
    expect(matchesLocation("USA", "usa")).toBe(true);
    expect(matchesLocation("Worldwide", "USA")).toBe(true);
    expect(matchesLocation("Anywhere", "us")).toBe(true);
    expect(matchesLocation("Northern America", "united states")).toBe(true);
    expect(matchesLocation("Europe", "usa")).toBe(false);
  });

  test("plain substring matching for other locations", () => {
    expect(matchesLocation("Canada, USA", "canada")).toBe(true);
    expect(matchesLocation("Germany", "france")).toBe(false);
  });
});

describe("query matching", () => {
  test("matches across title, company, and tags", () => {
    expect(jobMatchesQuery(WIRE, "react engineer")).toBe(true);
    expect(jobMatchesQuery(WIRE, "typescript")).toBe(true);
    expect(jobMatchesQuery(WIRE, "golang")).toBe(false);
  });
});

describe("normalizeId", () => {
  test("accepts numeric ids and remotive URLs", () => {
    expect(normalizeId("2090903")).toBe("2090903");
    expect(normalizeId("https://remotive.com/remote-jobs/software-dev/senior-react-engineer-2090903")).toBe("2090903");
    expect(normalizeId("senior-react-engineer-2090903")).toBe("2090903");
    expect(normalizeId("nope")).toBeNull();
  });
});

describe("htmlToText", () => {
  test("null for empty input", () => {
    expect(htmlToText("")).toBeNull();
  });
});
