-- Partial and composite indexes for hot list, pagination, and daily cleanup queries.
CREATE INDEX IF NOT EXISTS idx_artifacts_active_updated ON artifacts(updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_active_vis_updated ON artifacts(visibility, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_deleted ON artifacts(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uploads_artifact_version ON uploads(artifact_id, version);
CREATE INDEX IF NOT EXISTS idx_uploads_expires ON uploads(expires_at);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_pending ON artifact_versions(status, created_at) WHERE status = 'uploading' OR status = 'aborted' OR status = 'retiring';
CREATE INDEX IF NOT EXISTS idx_artifact_versions_ready ON artifact_versions(artifact_id, version DESC) WHERE status = 'ready';
