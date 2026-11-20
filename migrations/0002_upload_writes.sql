ALTER TABLE uploads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE upload_writes (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (upload_id, path)
);

-- Reconcile counters from uploads opened before this migration.
UPDATE uploads SET file_count = (
  SELECT COUNT(*) FROM artifact_files WHERE artifact_id = uploads.artifact_id AND version = uploads.version
);

CREATE TRIGGER reserve_upload_file AFTER INSERT ON upload_writes
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_files f JOIN uploads u ON u.artifact_id = f.artifact_id AND u.version = f.version
  WHERE u.id = NEW.upload_id AND f.path = NEW.path
)
BEGIN
  UPDATE uploads SET file_count = file_count + 1 WHERE id = NEW.upload_id;
END;

CREATE TRIGGER release_upload_file AFTER DELETE ON upload_writes
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_files f JOIN uploads u ON u.artifact_id = f.artifact_id AND u.version = f.version
  WHERE u.id = OLD.upload_id AND f.path = OLD.path
)
BEGIN
  UPDATE uploads SET file_count = file_count - 1 WHERE id = OLD.upload_id;
END;
