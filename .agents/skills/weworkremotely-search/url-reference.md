# We Work Remotely URL Reference

## Feeds

```
GET https://weworkremotely.com/categories/remote-programming-jobs.rss
GET https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss
GET https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss
GET https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss
GET https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss
GET https://weworkremotely.com/remote-jobs.rss          (all categories)
```

Standard RSS 2.0 with WWR extensions. ~25 items per category feed.

## Item shape / parsing anchors

```xml
<item>
  <media:content url="..."/>
  <title>Company: Job Title</title>
  <region>Anywhere in the World | USA Only | North America Only | ...</region>
  <category>Back-End Programming</category>
  <description>...entity-encoded (or CDATA) HTML — the FULL job listing...</description>
  <link>https://weworkremotely.com/remote-jobs/{slug}</link>
  <pubDate>Mon, 27 Jul 2026 12:00:00 +0000</pubDate>
  <guid>...</guid>
</item>
```

- Items are split on `<item>`; each tag is read with a CDATA- and
  entity-aware regex (`extractTag`), mirroring how the upstream portals parse
  HTML with regex.
- **Title**: `Company: Job Title` — split on the first `": "`. No colon → no
  company.
- **Id**: the slug from the `<link>` (`/remote-jobs/{slug}`); `<guid>` is the
  fallback link source.
- **Date**: RFC-2822 `<pubDate>` → `YYYY-MM-DD`.
- **Description**: the complete listing HTML (encoded); converted to readable
  text on `detail`. No extra page fetch is ever needed.
- **Salary**: no structured field. A conservative sniff fills salary_min/max
  only for an explicit dollar range of annual-sized amounts
  (`$120,000 - $150,000`, `$120k–$150k`); currency is then USD.

## Caching & politeness

- Feeds cache to `cli/.cache.json`
  (`{ "categories": { "<cat>": { "fetched_at", "items" } } }`) for **1 hour**;
  `WWR_CACHE_FILE` overrides the path (used by the offline tests).
- Exponential backoff with jitter on 429/5xx (500 ms → 8 s, 6 retries);
  20 s request timeout.
