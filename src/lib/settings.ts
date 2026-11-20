import type { Env, Visibility } from '../env';
import { VISIBILITIES } from '../env';
import { HttpError, now } from './http';

export interface Settings {
  password_login_enabled: boolean;
  server_unzip_enabled: boolean;
  /** Let visitors (not just the owner) download from the share page: the HTML file, or a ZIP of every file. */
  visitor_download_enabled: boolean;
  unzip_max_files: number;
  unzip_max_bytes: number;
  default_visibility: Visibility;
  default_indexable: boolean;
  keep_versions: number;
  max_file_bytes: number;
  max_version_files: number;
}

export const DEFAULT_SETTINGS: Settings = {
  password_login_enabled: true,
  server_unzip_enabled: false,
  visitor_download_enabled: false,
  unzip_max_files: 900,
  unzip_max_bytes: 32 * 1024 * 1024,
  default_visibility: 'private',
  default_indexable: false,
  keep_versions: 5,
  max_file_bytes: 100 * 1024 * 1024,
  max_version_files: 2000,
};

type Validator = (v: unknown) => boolean;
const int = (min: number, max: number): Validator => (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const bool: Validator = (v) => typeof v === 'boolean';
const VALIDATORS: Record<keyof Settings, Validator> = {
  password_login_enabled: bool,
  server_unzip_enabled: bool,
  visitor_download_enabled: bool,
  unzip_max_files: int(1, 950),
  // Zip + extracted files are held in memory together; keep well under the 128 MB isolate limit.
  unzip_max_bytes: int(1024, 48 * 1024 * 1024),
  default_visibility: (v) => VISIBILITIES.includes(v as Visibility),
  default_indexable: bool,
  keep_versions: int(1, 100),
  max_file_bytes: int(1024, 100 * 1024 * 1024),
  max_version_files: int(1, 10000),
};

const TTL_MS = 30_000;
let cache: { at: number; value: Settings } | null = null;

export function invalidateSettingsCache() {
  cache = null;
}

/** `fresh` bypasses the per-isolate cache; use it for security decisions (other isolates' caches aren't cleared on write). */
export async function getSettings(env: Env, opts: { fresh?: boolean } = {}): Promise<Settings> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const value: Settings = { ...DEFAULT_SETTINGS };
  for (const r of results) {
    if (Object.hasOwn(VALIDATORS, r.key)) {
      try {
        const v = JSON.parse(r.value);
        if (VALIDATORS[r.key as keyof Settings](v)) (value as unknown as Record<string, unknown>)[r.key] = v;
      } catch {
        /* ignore corrupt values */
      }
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(env: Env, patch: Record<string, unknown>): Promise<Settings> {
  const stmts: D1PreparedStatement[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const validate = Object.hasOwn(VALIDATORS, k) ? VALIDATORS[k as keyof Settings] : undefined;
    if (!validate) throw new HttpError(400, 'invalid_setting', `Unknown setting: ${k}`);
    if (!validate(v)) throw new HttpError(400, 'invalid_setting', `Invalid value for ${k}`);
    stmts.push(upsert(env, k, JSON.stringify(v)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  invalidateSettingsCache();
  return getSettings(env);
}

const upsert = (env: Env, key: string, value: string) =>
  env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(key, value, now());

// Internal (non-user-editable) values stored in the same table.
export async function getInternal(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setInternal(env: Env, key: string, value: string): Promise<void> {
  await upsert(env, key, value).run();
}
