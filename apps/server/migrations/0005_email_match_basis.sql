-- Why an inbound email was linked to an application, and what it could not
-- decide between.
--
-- Matching used to be `LIKE '%company%'` plus `.get()`: with two applications at
-- the same employer (or an agency writing about several roles) the first row
-- SQLite happened to return won, silently. A rejection could land on the wrong
-- application and move it to Rejected.
--
-- match_basis records the strongest signal that produced the link
-- ('url' | 'company_title' | 'company' | 'manual'), so the Inbox can show why.
-- match_candidates_json holds the applications a genuinely ambiguous email
-- could belong to; those emails keep application_id NULL and ask the user
-- instead of guessing.
ALTER TABLE emails ADD COLUMN match_basis TEXT;
ALTER TABLE emails ADD COLUMN match_candidates_json TEXT NOT NULL DEFAULT '[]';
