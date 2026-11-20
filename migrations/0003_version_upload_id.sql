-- Which upload session created a version. A commit deletes its session row, so without this a retried
-- commit (first response lost) can't be told apart from an aborted/expired session: it would get 404 and a
-- client could publish the same content again. With it, the retry gets 409 upload_closed.
-- Status values from here on: a committed version that is retired goes 'ready' → 'retiring' → 'purged'
-- (row kept, so "this upload was committed" stays answerable); 'aborted' → 'retired' is for aborted uploads.
ALTER TABLE artifact_versions ADD COLUMN upload_id TEXT;
CREATE INDEX idx_artifact_versions_upload ON artifact_versions(upload_id);
