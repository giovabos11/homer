import { describe, expect, test } from "bun:test";
import {
  extractTag,
  htmlToText,
  itemMatchesQuery,
  parseFeed,
  parseSalaryFromText,
  pubDateToIso,
  slugFromUrl,
  splitTitle,
  toDetail,
  toResult,
} from "../src/helpers";
import { normalizeId } from "../src/commands/detail";

// A minimal two-item feed in WWR's real shape: entity-encoded description,
// region/category extensions, standard link/pubDate.
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>We Work Remotely: Remote Programming Jobs</title>
  <item>
    <title>Tether: AI Research Engineer</title>
    <region>Anywhere in the World</region>
    <category>Back-End Programming</category>
    <description>&lt;p&gt;&lt;strong&gt;Salary:&lt;/strong&gt; $120,000 - $150,000&lt;/p&gt;&lt;p&gt;Build &amp;amp; ship models&lt;/p&gt;</description>
    <link>https://weworkremotely.com/remote-jobs/tether-ai-research-engineer</link>
    <pubDate>Mon, 27 Jul 2026 12:00:00 +0000</pubDate>
    <guid>https://weworkremotely.com/remote-jobs/tether-ai-research-engineer</guid>
  </item>
  <item>
    <title><![CDATA[Acme Corp: Senior React Developer]]></title>
    <region>USA Only</region>
    <category>Front-End Programming</category>
    <description><![CDATA[<p>React &amp; TypeScript work</p>]]></description>
    <link>https://weworkremotely.com/remote-jobs/acme-corp-senior-react-developer</link>
    <pubDate>Tue, 28 Jul 2026 09:30:00 +0000</pubDate>
  </item>
</channel></rss>`;

describe("parseFeed", () => {
  const items = parseFeed(FEED_XML);

  test("parses both items with slug ids", () => {
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("tether-ai-research-engineer");
    expect(items[1].id).toBe("acme-corp-senior-react-developer");
  });

  test("splits Company: Title and reads region/category/pubDate", () => {
    expect(items[0].company).toBe("Tether");
    expect(items[0].title).toBe("AI Research Engineer");
    expect(items[0].region).toBe("Anywhere in the World");
    expect(items[0].category).toBe("Back-End Programming");
    expect(items[0].date).toBe("2026-07-27");
  });

  test("handles CDATA titles and descriptions", () => {
    expect(items[1].company).toBe("Acme Corp");
    expect(items[1].title).toBe("Senior React Developer");
    expect(items[1].descriptionHtml).toContain("<p>React &amp; TypeScript work</p>");
  });
});

describe("result mapping", () => {
  const items = parseFeed(FEED_XML);

  test("toResult fills the portal contract, sniffing an explicit salary range", () => {
    const r = toResult(items[0]);
    expect(r.remote_type).toBe("remote");
    expect(r.location).toBe("Anywhere in the World");
    expect(r.salary_min).toBe(120000);
    expect(r.salary_max).toBe(150000);
    expect(r.salary_currency).toBe("USD");
    expect(r.url).toBe("https://weworkremotely.com/remote-jobs/tether-ai-research-engineer");
  });

  test("no explicit dollar range means null salary", () => {
    const r = toResult(items[1]);
    expect(r.salary_min).toBeNull();
    expect(r.salary_currency).toBeNull();
  });

  test("toDetail converts the encoded HTML description to text", () => {
    const d = toDetail(items[0]);
    expect(d.description).toContain("Salary: $120,000 - $150,000");
    expect(d.description).toContain("Build & ship models");
    expect(d.description).not.toContain("<p>");
  });
});

describe("parseSalaryFromText", () => {
  test("parses k-suffixed ranges", () => {
    expect(parseSalaryFromText("Pay: $120k–$150k plus equity")).toEqual({
      salary_min: 120000,
      salary_max: 150000,
      salary_currency: "USD",
    });
  });

  test("rejects small numbers and reversed ranges", () => {
    expect(parseSalaryFromText("costs $20 - $30").salary_min).toBeNull();
    expect(parseSalaryFromText("").salary_min).toBeNull();
  });
});

describe("small helpers", () => {
  test("splitTitle without a colon yields null company", () => {
    expect(splitTitle("Just A Title")).toEqual({ company: null, title: "Just A Title" });
  });

  test("slugFromUrl and normalizeId", () => {
    expect(slugFromUrl("https://weworkremotely.com/remote-jobs/some-job-slug")).toBe("some-job-slug");
    expect(normalizeId("some-job-slug")).toBe("some-job-slug");
    expect(normalizeId("https://weworkremotely.com/remote-jobs/some-job-slug")).toBe("some-job-slug");
    expect(normalizeId("not a slug!")).toBeNull();
  });

  test("pubDateToIso handles RFC-2822 and rejects garbage", () => {
    expect(pubDateToIso("Mon, 27 Jul 2026 12:00:00 +0000")).toBe("2026-07-27");
    expect(pubDateToIso("whenever")).toBeNull();
  });

  test("extractTag returns null when absent", () => {
    expect(extractTag("<item></item>", "region")).toBeNull();
  });

  test("itemMatchesQuery spans title, company, and description", () => {
    const items = parseFeed(FEED_XML);
    expect(itemMatchesQuery(items[1], "react developer")).toBe(true);
    expect(itemMatchesQuery(items[1], "typescript")).toBe(true);
    expect(itemMatchesQuery(items[1], "golang")).toBe(false);
  });

  test("htmlToText null for empty", () => {
    expect(htmlToText(null)).toBeNull();
  });
});
