-- Older versions inferred kind from file count and treated a lone Markdown document as a folder.
UPDATE artifact_versions
SET kind = 'markdown'
WHERE status = 'ready' AND kind = 'folder' AND file_count = 1
  AND (lower(entry) LIKE '%.md' OR lower(entry) LIKE '%.markdown');

UPDATE artifacts
SET kind = 'markdown'
WHERE kind = 'folder' AND EXISTS (
  SELECT 1 FROM artifact_versions v
  WHERE v.artifact_id = artifacts.id AND v.version = artifacts.current_version AND v.kind = 'markdown'
);
