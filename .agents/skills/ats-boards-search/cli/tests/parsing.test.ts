import { describe, expect, test } from "bun:test";
import {
  ashbySalary,
  greenhouseSalary,
  htmlToText,
  mapAshbyJob,
  mapGreenhouseJob,
  mapLeverJob,
  parseJobRef,
  remoteFromLocation,
  type AshbyJob,
  type Company,
  type GreenhouseJob,
  type LeverPosting,
} from "../src/helpers";
import { applyFilters, titleMatches } from "../src/commands/search";

const GH_CO: Company = { slug: "stripe", ats: "greenhouse", name: "Stripe" };
const LEVER_CO: Company = { slug: "palantir", ats: "lever", name: "Palantir Technologies" };
const ASHBY_CO: Company = { slug: "openai", ats: "ashby", name: "OpenAI" };

describe("mapGreenhouseJob", () => {
  const wire: GreenhouseJob = {
    id: 7954688,
    title: "Software Engineer, Payments",
    location: { name: "Remote in US" },
    absolute_url: "https://stripe.com/jobs/search?gh_jid=7954688",
    updated_at: "2026-07-27T11:17:30-04:00",
    first_published: "2026-06-02T08:58:57-04:00",
  };

  test("maps the wire shape into the portal contract", () => {
    const r = mapGreenhouseJob(GH_CO, wire);
    expect(r.id).toBe("greenhouse:stripe:7954688");
    expect(r.title).toBe("Software Engineer, Payments");
    expect(r.company).toBe("Stripe");
    expect(r.location).toBe("Remote in US");
    expect(r.date).toBe("2026-06-02"); // first_published wins over updated_at
    expect(r.url).toBe("https://stripe.com/jobs/search?gh_jid=7954688");
    expect(r.remote_type).toBe("remote");
    expect(r.salary_min).toBeNull();
    expect(r.salary_currency).toBeNull();
  });

  test("greenhouseSalary converts cents and prefers the USD range", () => {
    const s = greenhouseSalary([
      { min_cents: 100_000_00, max_cents: 150_000_00, currency_type: "CAD" },
      { min_cents: 120_000_00, max_cents: 180_000_00, currency_type: "USD" },
    ]);
    expect(s).toEqual({ salary_min: 120000, salary_max: 180000, salary_currency: "USD" });
  });

  test("greenhouseSalary is all-null when no ranges are published", () => {
    expect(greenhouseSalary(undefined)).toEqual({ salary_min: null, salary_max: null, salary_currency: null });
    expect(greenhouseSalary([])).toEqual({ salary_min: null, salary_max: null, salary_currency: null });
  });
});

describe("mapLeverJob", () => {
  const wire: LeverPosting = {
    id: "ac978161-6f46-4f6b-ad9e-a258e642751c",
    text: "Backend Engineer",
    categories: { commitment: "Full-time", location: "New York, NY", allLocations: ["New York, NY"] },
    workplaceType: "hybrid",
    createdAt: 1711403416463,
    hostedUrl: "https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c",
    salaryRange: { min: 135000, max: 200000, currency: "USD", interval: "per-year-salary" },
  };

  test("maps the wire shape into the portal contract", () => {
    const r = mapLeverJob(LEVER_CO, wire);
    expect(r.id).toBe("lever:palantir:ac978161-6f46-4f6b-ad9e-a258e642751c");
    expect(r.company).toBe("Palantir Technologies");
    expect(r.location).toBe("New York, NY");
    expect(r.date).toBe("2024-03-25"); // createdAt epoch ms
    expect(r.remote_type).toBe("hybrid");
    expect(r.salary_min).toBe(135000);
    expect(r.salary_max).toBe(200000);
    expect(r.salary_currency).toBe("USD");
  });

  test("workplaceType on-site maps to onsite; missing salaryRange stays null", () => {
    const r = mapLeverJob(LEVER_CO, { ...wire, workplaceType: "on-site", salaryRange: undefined });
    expect(r.remote_type).toBe("onsite");
    expect(r.salary_min).toBeNull();
    expect(r.salary_currency).toBeNull();
  });

  test("unspecified workplaceType falls back to the location string", () => {
    const r = mapLeverJob(LEVER_CO, {
      ...wire,
      workplaceType: "unspecified",
      categories: { location: "Remote - US" },
    });
    expect(r.remote_type).toBe("remote");
  });
});

describe("mapAshbyJob", () => {
  const wire: AshbyJob = {
    id: "8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3",
    title: "Software Engineer, Infrastructure",
    location: "San Francisco",
    publishedAt: "2026-03-12T16:38:15.322+00:00",
    isListed: true,
    isRemote: null,
    jobUrl: "https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3",
    employmentType: "FullTime",
    compensation: {
      summaryComponents: [
        { compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 257000, maxValue: 335000 },
        { compensationType: "EquityCashValue", interval: "1 YEAR", currencyCode: "USD", minValue: null, maxValue: null },
      ],
    },
  };

  test("maps the wire shape, reading salary from the Salary summary component", () => {
    const r = mapAshbyJob(ASHBY_CO, wire);
    expect(r.id).toBe("ashby:openai:8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3");
    expect(r.date).toBe("2026-03-12");
    expect(r.salary_min).toBe(257000);
    expect(r.salary_max).toBe(335000);
    expect(r.salary_currency).toBe("USD");
    expect(r.remote_type).toBeNull();
  });

  test("isRemote true maps to remote; equity-only compensation stays null", () => {
    const r = mapAshbyJob(ASHBY_CO, {
      ...wire,
      isRemote: true,
      compensation: {
        summaryComponents: [{ compensationType: "EquityCashValue", currencyCode: "USD", minValue: null, maxValue: null }],
      },
    });
    expect(r.remote_type).toBe("remote");
    expect(ashbySalary({ ...wire, compensation: undefined })).toEqual({
      salary_min: null,
      salary_max: null,
      salary_currency: null,
    });
    expect(r.salary_min).toBeNull();
  });

  test("workplaceType string wins over location text", () => {
    const r = mapAshbyJob(ASHBY_CO, { ...wire, workplaceType: "Hybrid" });
    expect(r.remote_type).toBe("hybrid");
  });
});

describe("parseJobRef", () => {
  test("parses <ats>:<slug>:<id> references", () => {
    expect(parseJobRef("greenhouse:stripe:7954688")).toEqual({ ats: "greenhouse", slug: "stripe", jobId: "7954688" });
    expect(parseJobRef("lever:palantir:ac978161-6f46-4f6b-ad9e-a258e642751c")).toEqual({
      ats: "lever",
      slug: "palantir",
      jobId: "ac978161-6f46-4f6b-ad9e-a258e642751c",
    });
  });

  test("parses board URLs for all three ATSes", () => {
    expect(parseJobRef("https://boards.greenhouse.io/stripe/jobs/7954688")).toEqual({
      ats: "greenhouse",
      slug: "stripe",
      jobId: "7954688",
    });
    expect(parseJobRef("https://job-boards.greenhouse.io/vercel/jobs/1234567")).toEqual({
      ats: "greenhouse",
      slug: "vercel",
      jobId: "1234567",
    });
    expect(parseJobRef("https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c")).toEqual({
      ats: "lever",
      slug: "palantir",
      jobId: "ac978161-6f46-4f6b-ad9e-a258e642751c",
    });
    expect(parseJobRef("https://jobs.ashbyhq.com/openai/8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3")).toEqual({
      ats: "ashby",
      slug: "openai",
      jobId: "8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3",
    });
  });

  test("returns null for unparseable references", () => {
    expect(parseJobRef("workday:acme:123")).toBeNull();
    expect(parseJobRef("just some text")).toBeNull();
  });
});

describe("filters", () => {
  test("titleMatches requires every query word", () => {
    expect(titleMatches("Senior Software Engineer, Payments", "software engineer")).toBe(true);
    expect(titleMatches("Senior Software Engineer, Payments", "staff engineer")).toBe(false);
  });

  test("remoteFromLocation classifies remote/hybrid strings", () => {
    expect(remoteFromLocation("Remote - US")).toBe("remote");
    expect(remoteFromLocation("Dallas, TX (Hybrid)")).toBe("hybrid");
    expect(remoteFromLocation("Dallas, TX")).toBeNull();
    expect(remoteFromLocation(null)).toBeNull();
  });

  test("jobage keeps undated rows and drops old ones", () => {
    const base = mapGreenhouseJob(GH_CO, {
      id: 1,
      title: "Engineer",
      absolute_url: "https://x.example",
      first_published: "2020-01-01T00:00:00Z",
    });
    const undated = { ...base, id: "greenhouse:stripe:2", date: null };
    const rows = applyFilters([base, undated], {
      query: undefined,
      location: undefined,
      remote: undefined,
      ats: undefined,
      companies: [],
      jobage: 14,
      page: 1,
      batch: 40,
      format: "json",
    });
    expect(rows.map((r) => r.id)).toEqual(["greenhouse:stripe:2"]);
  });
});

describe("htmlToText", () => {
  test("converts block tags to newlines and decodes entities", () => {
    const text = htmlToText("<p>Build &amp; ship</p><ul><li>TypeScript</li><li>React</li></ul>");
    expect(text).toBe("Build & ship\nTypeScript\nReact");
  });

  test("returns null for empty input", () => {
    expect(htmlToText("")).toBeNull();
    expect(htmlToText(null)).toBeNull();
  });
});
