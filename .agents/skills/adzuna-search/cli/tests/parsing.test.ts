import { describe, expect, test } from "bun:test";
import { sniffRemoteType, toDetail, toResult, type AdzunaJob } from "../src/helpers";
import { buildUrl, type SearchOpts } from "../src/commands/search";
import { normalizeId } from "../src/commands/detail";

const WIRE: AdzunaJob = {
  id: 5219438123,
  title: "Senior <strong>React</strong> Engineer",
  company: { display_name: "Acme Corp" },
  location: { display_name: "Dallas, Dallas County" },
  created: "2026-07-20T14:02:11Z",
  redirect_url: "https://www.adzuna.com/land/ad/5219438123?se=abc",
  salary_min: 128000.44,
  salary_max: 165000.0,
  salary_is_predicted: "1",
  description: "Fully remote role building React apps.",
  contract_time: "full_time",
  contract_type: "permanent",
  category: { label: "IT Jobs" },
};

function opts(partial: Partial<SearchOpts>): SearchOpts {
  return { query: undefined, location: undefined, remote: false, jobage: 9999, page: 1, limit: 25, format: "json", ...partial };
}

describe("toResult / toDetail", () => {
  test("maps the wire shape into the portal contract", () => {
    const r = toResult(WIRE);
    expect(r.id).toBe("5219438123");
    expect(r.title).toBe("Senior React Engineer"); // <strong> highlights stripped
    expect(r.company).toBe("Acme Corp");
    expect(r.location).toBe("Dallas, Dallas County");
    expect(r.date).toBe("2026-07-20");
    expect(r.salary_min).toBe(128000); // rounded
    expect(r.salary_max).toBe(165000);
    expect(r.salary_currency).toBe("USD");
    expect(r.salary_is_predicted).toBe(true);
    expect(r.remote_type).toBe("remote"); // sniffed from the description
  });

  test("missing salary stays null and unpredicted", () => {
    const r = toResult({ ...WIRE, salary_min: undefined, salary_max: undefined, salary_is_predicted: "0" });
    expect(r.salary_min).toBeNull();
    expect(r.salary_max).toBeNull();
    expect(r.salary_currency).toBeNull();
    expect(r.salary_is_predicted).toBe(false);
  });

  test("toDetail adds employment_type, category, and a text description", () => {
    const d = toDetail(WIRE);
    expect(d.employment_type).toBe("full_time, permanent");
    expect(d.category).toBe("IT Jobs");
    expect(d.description).toBe("Fully remote role building React apps.");
  });
});

describe("sniffRemoteType", () => {
  test("finds remote/hybrid keywords, else null", () => {
    expect(sniffRemoteType("Remote React Engineer", "")).toBe("remote");
    expect(sniffRemoteType("Engineer", "hybrid schedule in Dallas")).toBe("hybrid");
    expect(sniffRemoteType("Engineer", "onsite in Dallas")).toBeNull();
  });
});

describe("buildUrl", () => {
  test("carries credentials, paging, and filters", () => {
    const url = buildUrl(opts({ query: "react", location: "Dallas, TX", jobage: 14, page: 2, limit: 10 }), "myid", "mykey");
    expect(url).toStartWith("https://api.adzuna.com/v1/api/jobs/us/search/2?");
    const params = new URL(url).searchParams;
    expect(params.get("app_id")).toBe("myid");
    expect(params.get("app_key")).toBe("mykey");
    expect(params.get("what")).toBe("react");
    expect(params.get("where")).toBe("Dallas, TX");
    expect(params.get("max_days_old")).toBe("14");
    expect(params.get("results_per_page")).toBe("10");
  });

  test("--remote appends remote to the query", () => {
    const url = buildUrl(opts({ query: "react", remote: true }), "a", "b");
    expect(new URL(url).searchParams.get("what")).toBe("react remote");
  });
});

describe("normalizeId", () => {
  test("accepts numeric ids and Adzuna URLs", () => {
    expect(normalizeId("5219438123")).toBe("5219438123");
    expect(normalizeId("https://www.adzuna.com/land/ad/5219438123?se=abc")).toBe("5219438123");
    expect(normalizeId("https://www.adzuna.com/details/5219438123")).toBe("5219438123");
    expect(normalizeId("nope")).toBeNull();
  });
});
