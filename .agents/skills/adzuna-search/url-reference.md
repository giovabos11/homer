# Adzuna URL Reference

## Search

```
GET https://api.adzuna.com/v1/api/jobs/us/search/{page}
      ?app_id={ADZUNA_APP_ID}&app_key={ADZUNA_APP_KEY}
      &what={keywords}&where={place}
      &max_days_old={days}&results_per_page={n}
      &content-type=application/json
```

- `{page}` is 1-indexed and part of the **path**, not the query string.
- Other country endpoints exist (`/jobs/gb/`, `/jobs/de/`, ...); this skill
  pins `us`.
- Credentials come from the environment only; missing credentials exit with
  `MISSING_API_KEY` before any request. A 401/403 fails fast with a
  check-your-keys hint (no retry).

## Response fields read

`{ count, results: [...] }` — per job:

| Field | Meaning |
|-------|---------|
| `id` | Numeric id — the search-result `id` |
| `title` | May contain `<strong>` match highlights → tags stripped |
| `company.display_name` | Company |
| `location.display_name` | Place ("Dallas, Dallas County") |
| `created` | ISO timestamp |
| `redirect_url` | Adzuna redirect to the original posting (the result `url`) |
| `salary_min` / `salary_max` | USD, floats → rounded; absent/0 → null |
| `salary_is_predicted` | `"1"` when Adzuna estimated the salary |
| `description` | Truncated plain-ish text (used for detail + remote sniffing) |
| `contract_time` / `contract_type` | full_time/part_time, permanent/contract |
| `category.label` | Adzuna category |

`remote_type` is sniffed from title+description (`remote` / `hybrid` keywords)
— Adzuna US exposes no structured workplace field.

## Detail (cache-backed)

Adzuna has **no fetch-by-id endpoint**. `search` writes every raw result into
`cli/.cache.json` (`{ jobs: { "<id>": { cached_at, job } } }`, 7-day TTL,
500-entry LRU-ish cap; `ADZUNA_CACHE_FILE` overrides the path). `detail <id|url>`
reads only that cache:

- id sources accepted: bare numeric id, `adzuna.com/land/ad/{id}`,
  `adzuna.com/details/{id}`, `?ad={id}`.
- A miss returns `{ "code": "NOT_CACHED" }` telling the caller to run a search
  that returns the job first.

## Politeness

- One request per search invocation; exponential backoff with jitter on
  429/5xx (500 ms → 8 s, 6 retries); 30 s request timeout.
