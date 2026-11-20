-- Expected file list of an upload session, one row per path. Stored as rows rather than one JSON value in
-- uploads.expected: D1 caps a single value at ~2 MB, and a large manifest must neither fail nor be loaded
-- into memory whole. uploads.expected stays for sessions started before this migration.
CREATE TABLE upload_expected (
  upload_id TEXT NOT NULL,
  path      TEXT NOT NULL,
  PRIMARY KEY (upload_id, path)
);

-- Manifest state of a session: NULL = none declared, 'pending' while its rows are written, 'rows:<n>' when
-- complete. A separate column (not uploads.expected): code from before this migration JSON-parses
-- uploads.expected, so it must keep seeing NULL there — during a rollback or a gradual deploy, older code
-- then simply treats new sessions as having no manifest instead of crashing.
ALTER TABLE uploads ADD COLUMN manifest TEXT;
