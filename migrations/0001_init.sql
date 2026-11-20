-- Artifacts and their content versions
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,                    -- internal id, used by the API
  public_id       TEXT NOT NULL UNIQUE,                -- subdomain id; regenerating the link replaces it
  title           TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL,                       -- 'html' | 'folder'
  visibility      TEXT NOT NULL DEFAULT 'private',     -- 'private' | 'public' | 'password'
  password_enc    TEXT,
  password_ver    INTEGER NOT NULL DEFAULT 0,
  indexable       INTEGER NOT NULL DEFAULT 0,
  entry           TEXT NOT NULL DEFAULT 'index.html',
  spa_fallback    INTEGER NOT NULL DEFAULT 0,
  current_version INTEGER,
  view_count      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX idx_artifacts_updated ON artifacts(updated_at DESC);

CREATE TABLE artifact_versions (
  artifact_id  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL,                          -- 'uploading' | 'ready' | 'retiring' (being purged) | 'aborted' → 'retired' (kept: numbers never reused)
  entry        TEXT,                                   -- entry file of this version (set on commit)
  kind         TEXT,                                   -- 'html' | 'folder' (set on commit)
  file_count   INTEGER NOT NULL DEFAULT 0,
  total_size   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE artifact_files (
  artifact_id  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version, path)
);

-- In-progress uploads; the artifact row for a new artifact is created on commit
CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL,
  version      INTEGER NOT NULL,
  is_new       INTEGER NOT NULL,
  meta         TEXT NOT NULL,                          -- JSON: title, visibility, entry, ...
  expected     TEXT,                                   -- JSON array of expected paths, optional
  file_count   INTEGER NOT NULL DEFAULT 0,             -- distinct paths uploaded so far (limit check)
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                        -- SHA-256 of the cookie value
  method      TEXT NOT NULL,                           -- 'bootstrap' | 'password' | 'google' | 'github' | 'cloudflare'
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sso_providers (
  provider          TEXT PRIMARY KEY,                  -- 'google' | 'github' | 'cloudflare'
  enabled           INTEGER NOT NULL DEFAULT 0,
  client_id         TEXT,
  client_secret_enc TEXT,
  issuer            TEXT,
  bound_subject     TEXT,
  bound_display     TEXT,
  bound_at          INTEGER,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  purpose       TEXT NOT NULL,                         -- 'login' | 'bind'
  code_verifier TEXT NOT NULL,
  nonce         TEXT,
  redirect_to   TEXT,
  expires_at    INTEGER NOT NULL
);

-- One-time nonces (owner handoff tickets)
CREATE TABLE used_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Failed-attempt counters; each window starts at the first failure and lasts 10 minutes
CREATE TABLE rate_limits (
  bucket   TEXT PRIMARY KEY,                    -- 'login:<ip>' | 'unlock:<artifact_id>:<ip>'
  fails    INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL                     -- unix seconds when the window ends
);
