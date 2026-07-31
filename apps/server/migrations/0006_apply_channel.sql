-- Apply channel: what kind of apply target a posting's canonical URL actually is.
--
-- The pipeline used to treat every stored URL as a form it could drive. In the
-- live database that was false for most of the queue: whatjobs `pub_api__…`
-- syndication redirects (which dead-end on the aggregator's own homepage) and
-- Hacker News "Who is hiring" comment threads (applied to by emailing an address
-- in the comment text) both sat in Ready for review implying a submission was
-- about to happen. Neither is a form.
--
-- 'ats_form' | 'aggregator_redirect' | 'email' | 'unknown', derived from the URL
-- (plus source/description) and backfilled idempotently at boot.
ALTER TABLE jobs ADD COLUMN apply_channel TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_jobs_apply_channel ON jobs(apply_channel);
