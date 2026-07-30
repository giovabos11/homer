# USAJOBS URL Reference

## Search

```
GET https://data.usajobs.gov/api/search
      ?Keyword={text}&LocationName={place}
      &JobCategoryCode={series}&RemoteIndicator=True
      &DatePosted={days≤60}&ResultsPerPage={n}&Page={n}
```

Required headers (from environment variables only):

```
Authorization-Key: {USAJOBS_API_KEY}
User-Agent:        {USAJOBS_EMAIL}     ← the email registered with the key
```

Missing credentials exit with `MISSING_API_KEY` before any request; a 401/403
fails fast with a check-your-keys hint (no retry).

- `JobCategoryCode=2210` (default) = the IT Management occupational series;
  `--category none` drops the filter.
- `DatePosted` accepts 0–60 days; larger `--jobage` values are capped at 60.

## Response fields read

`SearchResult.SearchResultItems[]`, each
`{ MatchedObjectId, MatchedObjectDescriptor }`:

| Field | Meaning |
|-------|---------|
| `MatchedObjectId` | Control number — the search-result `id` |
| `PositionID` | Announcement number (e.g. `DE-12345-24-XY`) |
| `PositionTitle` / `OrganizationName` / `DepartmentName` | Title, agency, department |
| `PositionLocationDisplay` | Location text |
| `PositionURI` | `https://www.usajobs.gov/job/{control}` (the result `url`) |
| `ApplyURI[0]` | Direct apply link |
| `PublicationStartDate` / `ApplicationCloseDate` | Posting / hard close dates |
| `PositionRemuneration[]` | `{ MinimumRange, MaximumRange, RateIntervalCode, Description }` |
| `QualificationSummary` | Qualifications text |
| `UserArea.Details.JobSummary` / `.MajorDuties` / `.Requirements` | Description sources |
| `UserArea.Details.RemoteIndicator` / `.TeleworkEligible` | Workplace designation |

## Parsing anchors

- **Salary**: the remuneration entry with `RateIntervalCode === "PA"` (per
  annum) → `salary_min`/`salary_max` (rounded, USD). Hourly ("PH") and other
  intervals keep `salary_interval` but null numbers.
- **remote_type**: `RemoteIndicator: true` → `remote`; else
  `TeleworkEligible: true` → `hybrid`; else null.
- **Description** (detail): JobSummary + "Major duties:" + MajorDuties (array
  joined by newlines) + "Qualifications:" + QualificationSummary +
  "Requirements:".

## Detail lookup

No fetch-by-id endpoint exists. `detail <id>` issues one search with
`Keyword={id}` and matches exactly on `MatchedObjectId` or `PositionID`
(case-insensitive). Accepted inputs: bare control number, announcement number,
`https://www.usajobs.gov/job/{id}`, legacy `GetJob/ViewDetails/{id}` URLs.

## Politeness

- One request per invocation; exponential backoff with jitter on 429/5xx
  (500 ms → 8 s, 6 retries); 30 s request timeout.
