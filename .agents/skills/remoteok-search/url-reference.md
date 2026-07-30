# RemoteOK URL Reference

## Feed

```
GET https://remoteok.com/api
```

- Returns a single JSON array with the ~100 most recent remote job posts.
- **Element 0 is not a job** — it is a metadata/legal notice
  (`{ last_updated, legal }`) stating the API terms: link back to the RemoteOK
  URL and mention RemoteOK as the source. The CLI drops any element without an
  `id` + `position`.
- No query parameters are honored for filtering; all filtering is client-side.
- Send a descriptive `User-Agent`.

## Job fields read

| Field | Meaning |
|-------|---------|
| `id` | Numeric id (string) — the search-result `id` |
| `slug` | URL slug, e.g. `remote-brand-designer-symbiotic-1135528` |
| `position` | Job title |
| `company` | Company name |
| `location` | Region text ("Worldwide", "United States", ...) — often empty |
| `tags` | Tag list (`dev`, `react`, `full time`, ...) |
| `date` | ISO posting timestamp (feed is newest-first) |
| `epoch` | Posting time as UNIX seconds (fallback date source) |
| `url` | Canonical remoteok.com job URL (**keep as the link-back**) |
| `apply_url` | Site-relative apply redirect (`/l/<id>`) |
| `description` | Full HTML description → converted to text on `detail` |
| `salary_min` / `salary_max` | USD; **0 means "not posted"** → emitted as null |

## Caching

- The whole feed is cached to `cli/.cache.json` for **6 hours**
  (`{ fetched_at, jobs }`); search and detail both serve from it.
- `REMOTEOK_CACHE_FILE` overrides the cache path (used by the offline tests).
- Cache write failures are ignored (read-only filesystems still work).

## Politeness

- At most one live request per 6 hours per machine in normal use.
- Exponential backoff with jitter on 429/5xx (500 ms → 8 s, 6 retries);
  plain 4xx fails fast. 20 s request timeout.
