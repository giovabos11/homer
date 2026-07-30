import { describe, expect, test } from "bun:test";
import {
  parseRemuneration,
  remoteType,
  toDetail,
  toResult,
  type UsaJobsItem,
} from "../src/helpers";
import { buildUrl, type SearchOpts } from "../src/commands/search";
import { normalizeId } from "../src/commands/detail";

const ITEM: UsaJobsItem = {
  MatchedObjectId: "834567800",
  MatchedObjectDescriptor: {
    PositionID: "DE-12345-24-XY",
    PositionTitle: "IT Specialist (APPSW)",
    OrganizationName: "Department of the Treasury",
    DepartmentName: "Internal Revenue Service",
    PositionLocationDisplay: "Dallas, Texas",
    PositionURI: "https://www.usajobs.gov/job/834567800",
    ApplyURI: ["https://apply.usajobs.gov/834567800"],
    PublicationStartDate: "2026-07-10T00:00:00.0000000",
    ApplicationCloseDate: "2026-08-10T23:59:59.0000000",
    PositionRemuneration: [
      { MinimumRange: "112015.0", MaximumRange: "145617.0", RateIntervalCode: "PA", Description: "Per Year" },
    ],
    QualificationSummary: "Experience with software development.",
    UserArea: {
      Details: {
        JobSummary: "Develop and maintain applications.",
        MajorDuties: ["Write code.", "Review code."],
        RemoteIndicator: false,
        TeleworkEligible: true,
      },
    },
  },
};

function opts(partial: Partial<SearchOpts>): SearchOpts {
  return { query: undefined, location: undefined, remote: false, category: "2210", jobage: 9999, page: 1, limit: 25, format: "json", ...partial };
}

describe("toResult / toDetail", () => {
  test("maps the wire shape into the portal contract", () => {
    const r = toResult(ITEM);
    expect(r.id).toBe("834567800");
    expect(r.title).toBe("IT Specialist (APPSW)");
    expect(r.company).toBe("Department of the Treasury");
    expect(r.location).toBe("Dallas, Texas");
    expect(r.date).toBe("2026-07-10");
    expect(r.close_date).toBe("2026-08-10");
    expect(r.url).toBe("https://www.usajobs.gov/job/834567800");
    expect(r.salary_min).toBe(112015);
    expect(r.salary_max).toBe(145617);
    expect(r.salary_currency).toBe("USD");
    expect(r.salary_interval).toBe("Per Year");
    expect(r.remote_type).toBe("hybrid"); // telework-eligible, not remote
  });

  test("toDetail composes summary, duties, and qualifications", () => {
    const d = toDetail(ITEM);
    expect(d.department).toBe("Internal Revenue Service");
    expect(d.position_id).toBe("DE-12345-24-XY");
    expect(d.apply_url).toBe("https://apply.usajobs.gov/834567800");
    expect(d.description).toContain("Develop and maintain applications.");
    expect(d.description).toContain("Write code.\nReview code.");
    expect(d.description).toContain("Qualifications:");
  });
});

describe("parseRemuneration", () => {
  test("hourly-rated positions keep the interval but null numbers", () => {
    const s = parseRemuneration([{ MinimumRange: "35.5", MaximumRange: "45.0", RateIntervalCode: "PH", Description: "Per Hour" }]);
    expect(s.salary_min).toBeNull();
    expect(s.salary_max).toBeNull();
    expect(s.salary_currency).toBeNull();
    expect(s.salary_interval).toBe("Per Hour");
  });

  test("missing remuneration is all-null", () => {
    expect(parseRemuneration(undefined)).toEqual({
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
    });
  });

  test("prefers the annual range when several intervals are listed", () => {
    const s = parseRemuneration([
      { MinimumRange: "40", MaximumRange: "50", RateIntervalCode: "PH", Description: "Per Hour" },
      { MinimumRange: "90000", MaximumRange: "120000", RateIntervalCode: "PA", Description: "Per Year" },
    ]);
    expect(s.salary_min).toBe(90000);
    expect(s.salary_max).toBe(120000);
  });
});

describe("remoteType", () => {
  test("RemoteIndicator wins over TeleworkEligible; neither means null", () => {
    expect(remoteType({ UserArea: { Details: { RemoteIndicator: true, TeleworkEligible: true } } })).toBe("remote");
    expect(remoteType({ UserArea: { Details: { RemoteIndicator: false, TeleworkEligible: false } } })).toBeNull();
    expect(remoteType({})).toBeNull();
  });
});

describe("buildUrl", () => {
  test("carries keyword, location, category, paging, and the 60-day cap", () => {
    const url = buildUrl(opts({ query: "software", location: "Texas", jobage: 90, page: 2, limit: 10 }));
    const params = new URL(url).searchParams;
    expect(params.get("Keyword")).toBe("software");
    expect(params.get("LocationName")).toBe("Texas");
    expect(params.get("JobCategoryCode")).toBe("2210");
    expect(params.get("DatePosted")).toBe("60"); // capped
    expect(params.get("ResultsPerPage")).toBe("10");
    expect(params.get("Page")).toBe("2");
  });

  test("--category none drops the series filter; --remote adds RemoteIndicator", () => {
    const url = buildUrl(opts({ category: "none", remote: true }));
    const params = new URL(url).searchParams;
    expect(params.get("JobCategoryCode")).toBeNull();
    expect(params.get("RemoteIndicator")).toBe("True");
  });
});

describe("normalizeId", () => {
  test("accepts control numbers, announcement ids, and usajobs URLs", () => {
    expect(normalizeId("834567800")).toBe("834567800");
    expect(normalizeId("DE-12345-24-XY")).toBe("DE-12345-24-XY");
    expect(normalizeId("https://www.usajobs.gov/job/834567800")).toBe("834567800");
    expect(normalizeId("not an id!")).toBeNull();
  });
});
