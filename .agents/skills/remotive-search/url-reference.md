# Remotive URL Reference

## API

```
GET https://remotive.com/api/remote-jobs?category={category}
```

- Response envelope: `{ "00-warning", "0-legal-notice", "job-count",
  "total-job-count", "jobs": [...] }`. Only `jobs` is read.
- The API also supports `search` and `limit` params — **deliberately unused**:
  Remotive's guidelines cap polling at a couple of requests per day, so the CLI
  fetches the whole category once and filters client-side from a 12h cache.
- Category slugs: `software-dev` (default), `data`, `devops`, `product`,
  `design`, `marketing`, `customer-support`, `sales-business`, `finance-legal`,
  `hr`, `qa`, `writing`, `all-others`.

## Job fields read

| Field | Meaning |
|-------|---------|
| `id` | Numeric id — the search-result `id` |
| `url` | Canonical remotive.com job URL (**keep as the link-back**) |
| `title` | Job title |
| `company_name` | Company |
| `category` | Category label |
| `tags` | Skill/keyword tags |
| `job_type` | `full_time`, `contract`, `freelance`, ... |
| `publication_date` | ISO timestamp (no timezone) |
| `candidate_required_location` | Eligibility region ("USA", "Worldwide", "Northern America", ...) |
| `salary` | Free text ("$130,000 - $160,000/yr", "$18 - $22/hr", often empty) |
| `description` | Full HTML description → converted to text on `detail` |

## Parsing anchors

- **Salary**: numbers with comma-thousands or a `k` suffix; ranges take
  min/max. Currency from `$`/`USD`, `€`/`EUR`, `£`/`GBP`. Strings flagged
  hourly/daily/weekly (`/hr`, `per hour`, `/day`, `/week`) are never converted
  to annual numbers.
- **US eligibility**: a wanted location of `us`/`usa`/`united states` matches
  `candidate_required_location` values containing Worldwide / Anywhere /
  North(ern) America / Americas / USA / United States / US.

## Caching & politeness

- Cache file `cli/.cache.json`, shape
  `{ "categories": { "<slug>": { "fetched_at", "jobs" } } }`, TTL **12 hours**
  per category → max ~2 real fetches/day per category.
- `REMOTIVE_CACHE_FILE` overrides the path (used by the offline tests).
- Exponential backoff with jitter on 429/5xx (500 ms → 8 s, 6 retries);
  30 s request timeout.
