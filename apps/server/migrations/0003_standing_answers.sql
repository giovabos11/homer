-- Standing answers: the "answer once, reuse forever" store behind the review
-- modal and the apply driver (FR-9). Normal data — a `db`-scope reset wipes it,
-- exactly like jobs/applications; defaults come back empty, not invented.
CREATE TABLE IF NOT EXISTS standing_answers (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Applications remember whether the gate submitted them without a human click,
-- so an auto-submitted application is never silently invisible in Applied.
ALTER TABLE applications ADD COLUMN auto_submitted INTEGER NOT NULL DEFAULT 0;
