ALTER TABLE oauth_states ADD COLUMN session_id TEXT;
ALTER TABLE oauth_states ADD COLUMN provider_config TEXT;

-- All sign-in configuration writes are serialized by D1. Check the alternative method
-- at write time, since a concurrent request may have disabled it after validation.
CREATE TRIGGER protect_last_sso BEFORE UPDATE ON sso_providers
WHEN OLD.enabled = 1 AND OLD.bound_subject IS NOT NULL AND OLD.client_id IS NOT NULL
  AND OLD.client_secret_enc IS NOT NULL AND (OLD.provider != 'cloudflare' OR OLD.issuer IS NOT NULL)
  AND (NEW.enabled != 1 OR NEW.bound_subject IS NULL OR OLD.client_id IS NOT NEW.client_id
    OR OLD.client_secret_enc IS NOT NEW.client_secret_enc OR OLD.issuer IS NOT NEW.issuer)
  AND (SELECT value FROM settings WHERE key = 'password_login_enabled') = 'false'
  AND NOT EXISTS (
    SELECT 1 FROM sso_providers WHERE provider != OLD.provider AND enabled = 1 AND bound_subject IS NOT NULL
      AND client_id IS NOT NULL AND client_secret_enc IS NOT NULL AND (provider != 'cloudflare' OR issuer IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'sign_in_method_required');
END;

CREATE TRIGGER protect_last_password_insert BEFORE INSERT ON settings
WHEN NEW.key = 'password_login_enabled' AND NEW.value = 'false'
  AND NOT EXISTS (
    SELECT 1 FROM sso_providers WHERE enabled = 1 AND bound_subject IS NOT NULL
      AND client_id IS NOT NULL AND client_secret_enc IS NOT NULL AND (provider != 'cloudflare' OR issuer IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'sign_in_method_required');
END;

CREATE TRIGGER protect_last_password_update BEFORE UPDATE OF value ON settings
WHEN NEW.key = 'password_login_enabled' AND NEW.value = 'false'
  AND NOT EXISTS (
    SELECT 1 FROM sso_providers WHERE enabled = 1 AND bound_subject IS NOT NULL
      AND client_id IS NOT NULL AND client_secret_enc IS NOT NULL AND (provider != 'cloudflare' OR issuer IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'sign_in_method_required');
END;
