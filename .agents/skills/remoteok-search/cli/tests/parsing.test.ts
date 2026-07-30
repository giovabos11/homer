import { describe, expect, test } from "bun:test";
import { htmlToText, isJob, jobMatchesQuery, toDetail, toResult, type RemoteOKJob } from "../src/helpers";
import { filterJobs, type SearchOpts } from "../src/commands/search";
import { findJob, normalizeId } from "../src/commands/detail";

const WIRE: RemoteOKJob = {
  id: "1135528",
  slug: "remote-senior-react-engineer-acme-1135528",
  position: "Senior React Engineer",
  company: "Acme",
  location: "United States",
  tags: ["dev", "react", "full time"],
  date: "2026-07-28T01:55:43+00:00",
  url: "https://remoteOK.com/remote-jobs/remote-senior-react-engineer-acme-1135528",
  apply_url: "/l/1135528",
  description: "<p>Build &amp; ship UI</p><ul><li>React</li><li>TypeScript</li></ul>",
  salary_min: 120000,
  salary_max: 170000,
};

const NO_SALARY: RemoteOKJob = { ...WIRE, id: "2", slug: "x-2", position: "Backend Engineer", tags: ["dev", "python"], salary_min: 0, salary_max: 0 };

function opts(partial: Partial<SearchOpts>): SearchOpts {
  return { query: undefined, location: undefined, tags: [], jobage: 9999, page: 1, limit: 25, format: "json", ...partial };
}

describe("feed element classification", () => {
  test("the legal/metadata first element is not a job", () => {
    expect(isJob({ last_updated: 1785266996, legal: "API Terms of Service..." })).toBe(false);
    expect(isJob(WIRE)).toBe(true);
  });
});

describe("toResult / toDetail", () => {
  test("maps the wire shape into the portal contract", () => {
    const r = toResult(WIRE);
    expect(r.id).toBe("1135528");
    expect(r.title).toBe("Senior React Engineer");
    expect(r.company).toBe("Acme");
    expect(r.date).toBe("2026-07-28");
    expect(r.remote_type).toBe("remote");
    expect(r.salary_min).toBe(120000);
    expect(r.salary_max).toBe(170000);
    expect(r.salary_currency).toBe("USD");
  });

  test("salary of 0 is treated as missing (null), currency null too", () => {
    const r = toResult(NO_SALARY);
    expect(r.salary_min).toBeNull();
    expect(r.salary_max).toBeNull();
    expect(r.salary_currency).toBeNull();
  });

  test("detail converts the HTML description to text and roots apply_url", () => {
    const d = toDetail(WIRE);
    expect(d.description).toBe("Build & ship UI\nReact\nTypeScript");
    expect(d.apply_url).toBe("https://remoteok.com/l/1135528");
  });
});

describe("filtering", () => {
  test("query words match across title, company, and tags", () => {
    expect(jobMatchesQuery(WIRE, "react engineer")).toBe(true);
    expect(jobMatchesQuery(WIRE, "typescript")).toBe(true); // in description
    expect(jobMatchesQuery(WIRE, "golang")).toBe(false);
  });

  test("--tags requires every listed tag", () => {
    expect(filterJobs([WIRE, NO_SALARY], opts({ tags: ["dev", "react"] }))).toEqual([WIRE]);
    expect(filterJobs([WIRE, NO_SALARY], opts({ tags: ["dev"] }))).toEqual([WIRE, NO_SALARY]);
  });

  test("--location substring match", () => {
    expect(filterJobs([WIRE], opts({ location: "united" }))).toEqual([WIRE]);
    expect(filterJobs([WIRE], opts({ location: "germany" }))).toEqual([]);
  });
});

describe("detail id handling", () => {
  test("normalizeId accepts ids, slugs, and URLs", () => {
    expect(normalizeId("1135528")).toBe("1135528");
    expect(normalizeId("remote-senior-react-engineer-acme-1135528")).toBe("remote-senior-react-engineer-acme-1135528");
    expect(normalizeId("https://remoteok.com/remote-jobs/remote-senior-react-engineer-acme-1135528")).toBe(
      "remote-senior-react-engineer-acme-1135528",
    );
    expect(normalizeId("not a slug!")).toBeNull();
  });

  test("findJob resolves by id, slug, and slug-embedded id", () => {
    expect(findJob([WIRE], "1135528")).toBe(WIRE);
    expect(findJob([WIRE], WIRE.slug!)).toBe(WIRE);
    expect(findJob([WIRE], "some-other-prefix-1135528")).toBe(WIRE);
    expect(findJob([WIRE], "999")).toBeUndefined();
  });
});

describe("htmlToText", () => {
  test("null for empty input", () => {
    expect(htmlToText("")).toBeNull();
    expect(htmlToText(undefined)).toBeNull();
  });
});
