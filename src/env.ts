export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  MAIN_HOST: string;
  CONTENT_ZONE: string;
  /** Appended to the artifact id in its subdomain: `{public_id}{suffix}.{CONTENT_ZONE}`. Default `-share`. */
  CONTENT_HOST_SUFFIX?: string;
  SECRET_KEY: string;
  ADMIN_BOOTSTRAP_PASSWORD?: string;
  /** Initial admin username (default "admin"); can be changed in the admin UI afterwards. */
  ADMIN_USERNAME?: string;
  /** Cloudflare Turnstile on the login page (both must be set to enable it). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export type Visibility = 'private' | 'public' | 'password';
export const VISIBILITIES: Visibility[] = ['private', 'public', 'password'];

export interface ArtifactRow {
  id: string;
  /** Subdomain id; can be regenerated to invalidate the old link. */
  public_id: string;
  title: string;
  kind: 'html' | 'folder';
  visibility: Visibility;
  password_enc: string | null;
  password_ver: number;
  indexable: number;
  entry: string;
  spa_fallback: number;
  current_version: number | null;
  view_count: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
