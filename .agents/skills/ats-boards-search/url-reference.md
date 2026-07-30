# ATS Boards URL Reference

Official, unauthenticated JSON job-board APIs used by this skill. All three are
published by the ATS vendors for programmatic job-board embedding — no HTML
parsing anywhere in this skill.

## Greenhouse (Job Board API)

```
GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}
```

- List response: `{ "jobs": [...], "meta": { "total": n } }`.
- Job fields read: `id`, `title`, `location.name`, `absolute_url`,
  `first_published` (preferred date), `updated_at`, `company_name`.
- Detail adds `content` — **HTML-escaped HTML** (`&lt;p&gt;...`), so the CLI
  unescapes one layer, then strips tags to text.
- Salary: `pay_input_ranges: [{ min_cents, max_cents, currency_type, title }]`
  on the detail response, only where the company publishes pay transparency
  ranges. Cents → dollars; a USD range is preferred when several jurisdictions
  are listed.
- 404 = board token does not exist.

## Lever (Postings API)

```
GET https://api.lever.co/v0/postings/{site}?mode=json
GET https://api.lever.co/v0/postings/{site}/{posting_id}
```

- List response: a bare JSON array of postings (`?limit=` and `&skip=` exist,
  but the sweep reads the whole list and filters client-side).
- Posting fields read: `id` (uuid), `text` (title), `categories.location` /
  `categories.allLocations` / `categories.commitment`, `workplaceType`
  (`remote` | `hybrid` | `on-site` | `unspecified`), `createdAt` (epoch ms),
  `hostedUrl`, `country`, `descriptionPlain`, `additionalPlain`, `openingPlain`.
- Salary: `salaryRange: { min, max, currency, interval }` where posted.
- EU-hosted boards live at `jobs.eu.lever.co` URLs; the API host is the same.

## Ashby (Posting API)

```
GET https://api.ashbyhq.com/posting-api/job-board/{job_board_name}
GET https://api.ashbyhq.com/posting-api/job-board/{job_board_name}?includeCompensation=true
```

- Response: `{ "jobs": [...], "apiVersion": "1" }`. There is **no per-job
  endpoint** — `detail` re-fetches the board and selects by `id`.
- Job fields read: `id` (uuid), `title`, `location`, `secondaryLocations`,
  `employmentType`, `publishedAt`, `isListed` (unlisted jobs are skipped),
  `isRemote`, `workplaceType` (`Remote` | `Hybrid` | `Onsite`), `jobUrl`,
  `applyUrl`, `descriptionHtml`, `descriptionPlain`, `compensation`.
- Salary: `compensation.summaryComponents[]` — the component with
  `compensationType === "Salary"` carries `minValue`, `maxValue`,
  `currencyCode` (equity-only components are ignored).

## Result ids

Search results use `"<ats>:<company-slug>:<job-id>"`, e.g.
`greenhouse:stripe:7954688`, `lever:palantir:<uuid>`, `ashby:openai:<uuid>`.
`detail` also accepts these public URL shapes:

```
https://boards.greenhouse.io/{slug}/jobs/{id}
https://job-boards.greenhouse.io/{slug}/jobs/{id}
https://jobs.lever.co/{slug}/{uuid}          (also jobs.eu.lever.co)
https://jobs.ashbyhq.com/{slug}/{uuid}
```

## Politeness

- Sequential sweep, global cap ~2 request-starts/second (500 ms spacing).
- Exponential backoff with jitter on 429/5xx (500 ms → 8 s, 6 retries).
- 30 s request timeout.
- `--page`/`--batch` page the sweep **by company** so a single invocation stays
  bounded (default 40 companies ≈ 20–30 s).

## Registry maintenance

`companies.json` entries were live-verified at build time (2026-07). Boards do
move (companies switch ATS vendors); a 404 shows up in `meta.errors` as
`"board not found (404)"` — remove or fix the entry when that becomes
persistent. New entries you have not checked should carry `"unverified": true`.
