# HN "Who is hiring?" URL Reference

Public Algolia Hacker News API — no authentication.

## Thread discovery

```
GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10
```

Returns the `whoishiring` bot's recent stories, newest first. The bot posts
three monthly threads ("Who is hiring?", "Who wants to be hired?",
"Freelancer? Seeking freelancer?"); the CLI picks the newest hit whose title
matches `/who is hiring/i`. The hit's `objectID` is the thread story id.

## Thread fetch

```
GET https://hn.algolia.com/api/v1/items/{story_id}
```

Returns the full item tree: `{ id, title, children: [...] }`. **Each top-level
child comment is one job posting** (`{ id, author, created_at, text }`, where
`text` is HTML). Dead/deleted comments have empty `text` and are skipped.
Replies (nested children) are not postings and are ignored.

## Detail

```
GET https://hn.algolia.com/api/v1/items/{comment_id}
```

Returns the single comment; works for any month's thread without touching the
cache. Public URL shape accepted as detail input:
`https://news.ycombinator.com/item?id={comment_id}`.

## Parsing anchors (best-effort header convention)

First line of the comment text: `Company | Role | Location | Salary | REMOTE`.

- **Segments**: split on `|`; a pipe-less header falls back to ` - ` dashes.
- **Company**: segment 0 (always).
- **Role**: first later segment matching engineer/developer/full-stack/
  backend/frontend/mobile/devops/etc.
- **Location**: first later segment matching "City, ST"/"City, Country"
  patterns or known region keywords (US/USA/EU/Worldwide/major cities).
- **remote_type**: first REMOTE/HYBRID/ONSITE/IN-PERSON keyword in the header,
  else in the first 400 chars of the text.
- **Salary**: `$150k-$200k` or `$150,000 - $200,000` ranges (annual-sized,
  USD); anything else stays null.
- **Comment HTML**: paragraphs arrive as `<p>` tags with entity-encoded text →
  converted to newline-separated plain text.

## Caching & politeness

- Cache file `cli/.cache.json`:
  `{ latest: { checked_at, id, title }, threads: { "<id>": { fetched_at, title, comments } } }`.
- Latest-thread pointer and each thread tree cache for **6 hours**; only the 3
  most recently touched threads are retained. `HN_CACHE_FILE` overrides the
  path (used by the offline tests).
- Exponential backoff with jitter on 429/5xx (500 ms → 8 s, 6 retries); 30 s
  request timeout.
