import type { ArtifactRow, Env, Visibility } from '../env';
import { VISIBILITIES } from '../env';
import { decryptString, encryptString, randomAccessCode, randomBase62 } from './crypto';
import { contentOrigin, mainOrigin } from './hosts';
import { HttpError, now } from './http';
import { contentTypeFor, isHtmlPath } from './mime';
import { inferEntry, isIgnoredPath, normalizePath, stripCommonRoot } from './paths';
import { getSettings, type Settings } from './settings';

export const UPLOAD_TTL_SEC = 24 * 3600;

export interface ArtifactMeta {
  title?: string;
  visibility?: Visibility;
  entry?: string;
  spa_fallback?: boolean;
  indexable?: boolean;
}

export interface UploadRow {
  id: string;
  artifact_id: string;
  version: number;
  is_new: number;
  meta: string;
  /** Legacy: JSON array of expected paths (sessions created before migration 0002). */
  expected: string | null;
  /** NULL = no manifest; 'pending' while its rows are written; 'rows:<n>' when complete (rows in upload_expected). */
  manifest?: string | null;
  file_count?: number;
  created_by: string | null;
  created_at: number;
  expires_at: number;
}

/** A single HTML file is an 'html' artifact; anything else is a 'folder' (downloads follow this). */
export const kindOf = (paths: string[]): 'html' | 'folder' => (paths.length === 1 && isHtmlPath(paths[0]) ? 'html' : 'folder');

export const r2Prefix = (id: string, version?: number) => (version === undefined ? `a/${id}/` : `a/${id}/v${version}/`);
export const r2Key = (id: string, version: number, path: string) => `${r2Prefix(id, version)}${path}`;

// ---------- meta parsing ----------

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  throw new HttpError(400, 'invalid_meta', `Invalid boolean: ${String(v)}`);
}

/** Validates loosely-typed metadata from JSON bodies, query strings or headers. */
export function parseMeta(raw: Record<string, unknown>): ArtifactMeta {
  const meta: ArtifactMeta = {};
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== 'string' || raw.title.length > 200) throw new HttpError(400, 'invalid_meta', 'title must be a string up to 200 chars');
    meta.title = raw.title.trim();
  }
  if (raw.visibility !== undefined && raw.visibility !== null && raw.visibility !== '') {
    if (!VISIBILITIES.includes(raw.visibility as Visibility)) throw new HttpError(400, 'invalid_meta', 'visibility must be private, public or password');
    meta.visibility = raw.visibility as Visibility;
  }
  if (raw.entry !== undefined && raw.entry !== null && raw.entry !== '') {
    const e = normalizePath(String(raw.entry));
    if (!e) throw new HttpError(400, 'invalid_meta', 'invalid entry path');
    meta.entry = e;
  }
  const spa = parseBool(raw.spa_fallback);
  if (spa !== undefined) meta.spa_fallback = spa;
  const idx = parseBool(raw.indexable);
  if (idx !== undefined) meta.indexable = idx;
  return meta;
}

export function metaFromRequest(req: Request): ArtifactMeta {
  const url = new URL(req.url);
  const raw: Record<string, unknown> = {};
  for (const k of ['title', 'visibility', 'entry', 'spa_fallback', 'indexable']) {
    const q = url.searchParams.get(k);
    const h = req.headers.get(`x-artifact-${k.replace('_', '-')}`);
    const v = q ?? (h !== null ? safeDecode(h) : null);
    if (v !== null) raw[k] = v;
  }
  return parseMeta(raw);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------- artifacts ----------

export async function getArtifact(env: Env, id: string): Promise<ArtifactRow | null> {
  return env.DB.prepare('SELECT * FROM artifacts WHERE id = ? AND deleted_at IS NULL').bind(id).first<ArtifactRow>();
}

/** Looks up an artifact by its subdomain id. */
export async function getArtifactByPublicId(env: Env, publicId: string): Promise<ArtifactRow | null> {
  return env.DB.prepare('SELECT * FROM artifacts WHERE public_id = ? AND deleted_at IS NULL').bind(publicId).first<ArtifactRow>();
}

export async function requireArtifact(env: Env, id: string): Promise<ArtifactRow> {
  const a = await getArtifact(env, id);
  if (!a) throw new HttpError(404, 'not_found', 'Artifact not found');
  return a;
}

export const viewerUrl = (env: Env, publicId: string, ref: URL) => `${mainOrigin(env, ref)}/s/${publicId}`;

/** API view of an artifact. `withPassword: false` skips decrypting the access code (lists don't need it). */
export async function artifactView(env: Env, a: ArtifactRow, ref: URL, opts: { withPassword?: boolean } = {}) {
  return {
    id: a.id,
    public_id: a.public_id,
    title: a.title,
    kind: a.kind,
    visibility: a.visibility,
    password: a.visibility === 'password' && opts.withPassword !== false ? await decryptString(env.SECRET_KEY, a.password_enc) : null,
    indexable: !!a.indexable,
    entry: a.entry,
    spa_fallback: !!a.spa_fallback,
    current_version: a.current_version,
    view_count: a.view_count,
    created_at: a.created_at,
    updated_at: a.updated_at,
    /** Share link: the viewer page on the main domain (top bar + sandboxed iframe). */
    url: viewerUrl(env, a.public_id, ref),
    /** Raw content on the artifact's own subdomain (what the viewer's iframe loads). */
    content_url: `${contentOrigin(env, a.public_id, ref)}/`,
  };
}

/**
 * SQL for a metadata change: only the columns being changed (never a full write-back of a row read
 * earlier, which would undo a concurrent writer — e.g. resurrect an access code that was just reset).
 * A fresh code is issued whenever the artifact *enters* password mode, has none, or on reset; switching back
 * from private/public must not revive a code (or unlock cookies / download tokens) the owner meant to revoke.
 */
async function metaChanges(env: Env, meta: ArtifactMeta, opts: { resetPassword?: boolean } = {}): Promise<{ sets: string[]; binds: unknown[] }> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), binds.push(v));
  if (meta.title !== undefined) set('title', meta.title);
  if (meta.spa_fallback !== undefined) set('spa_fallback', meta.spa_fallback ? 1 : 0);
  if (meta.indexable !== undefined) set('indexable', meta.indexable ? 1 : 0);
  if (meta.entry !== undefined) set('entry', meta.entry);
  if (meta.visibility !== undefined) set('visibility', meta.visibility);
  if (opts.resetPassword || meta.visibility === 'password') {
    const rotate = opts.resetPassword ? '1' : "visibility != 'password' OR password_enc IS NULL";
    sets.push(`password_enc = CASE WHEN ${rotate} THEN ? ELSE password_enc END`);
    binds.push(await encryptString(env.SECRET_KEY, randomAccessCode()));
    sets.push(`password_ver = password_ver + CASE WHEN ${rotate} THEN 1 ELSE 0 END`);
  }
  return { sets, binds };
}

export async function patchArtifact(env: Env, a: ArtifactRow, meta: ArtifactMeta, opts: { resetPassword?: boolean } = {}): Promise<ArtifactRow> {
  const { sets, binds } = await metaChanges(env, meta, opts);
  sets.push('updated_at = ?');
  binds.push(now(), a.id);
  const where = ['id = ?', 'deleted_at IS NULL'];
  if (meta.entry !== undefined) {
    where.push('EXISTS (SELECT 1 FROM artifact_files WHERE artifact_id = artifacts.id AND version = artifacts.current_version AND path = ?)');
    binds.push(meta.entry);
  }
  if (opts.resetPassword) where.push("visibility = 'password'");
  const result = await env.DB.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).bind(...binds).run();
  if (!result.meta.changes) {
    await requireArtifact(env, a.id);
    if (opts.resetPassword) throw new HttpError(400, 'not_password_protected', 'Artifact is not in password mode');
    throw new HttpError(400, 'invalid_entry', `Entry file not found: ${meta.entry}`);
  }
  return requireArtifact(env, a.id);
}

/**
 * Gives the artifact a new subdomain; the old link stops working immediately.
 * Optionally regenerates the access code as well.
 */
export async function regenerateLink(env: Env, a: ArtifactRow, opts: { resetPassword?: boolean } = {}): Promise<ArtifactRow> {
  const publicId = crypto.randomUUID();
  if (opts.resetPassword) {
    const result = await env.DB.prepare("UPDATE artifacts SET public_id = ?, password_enc = ?, password_ver = password_ver + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND visibility = 'password'")
      .bind(publicId, await encryptString(env.SECRET_KEY, randomAccessCode()), now(), a.id)
      .run();
    if (!result.meta.changes) {
      await requireArtifact(env, a.id);
      throw new HttpError(400, 'not_password_protected', 'Artifact is not in password mode');
    }
  } else {
    await env.DB.prepare('UPDATE artifacts SET public_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(publicId, now(), a.id).run();
  }
  return requireArtifact(env, a.id);
}

export async function softDeleteArtifact(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE artifacts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(now(), id).run();
}

/** Removes every trace of an artifact (R2 objects and rows). */
export async function purgeArtifact(env: Env, id: string): Promise<void> {
  // Upload sessions go first: an in-flight PUT then fails its liveness check and cleans up after itself,
  // and anything it wrote before that is caught by the prefix delete that follows.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM upload_expected WHERE upload_id IN (SELECT id FROM uploads WHERE artifact_id = ?)').bind(id),
    env.DB.prepare('DELETE FROM uploads WHERE artifact_id = ?').bind(id),
  ]);
  await deletePrefix(env, r2Prefix(id));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM artifact_files WHERE artifact_id = ?').bind(id),
    env.DB.prepare('DELETE FROM artifact_versions WHERE artifact_id = ?').bind(id),
    env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
  ]);
}

/** Removes a version's stored files (R2 objects + file rows); the version row itself is the caller's business. */
export async function purgeVersionFiles(env: Env, id: string, version: number): Promise<void> {
  await deletePrefix(env, r2Prefix(id, version));
  await env.DB.prepare('DELETE FROM artifact_files WHERE artifact_id = ? AND version = ?').bind(id, version).run();
}

export async function deletePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

/**
 * Claims an old version before purging its files. The claim prevents a concurrent rollback from activating
 * it and lets cleanup retry a failed purge. Once purged, the row is kept as 'purged': it still reserves the version number and still records
 * that its upload was committed ('retired' marks aborted uploads only).
 */
export async function retireVersion(env: Env, id: string, version: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE artifact_versions SET status = 'retiring' WHERE artifact_id = ?1 AND version = ?2 AND status IN ('ready', 'retiring') AND version IS NOT (SELECT current_version FROM artifacts WHERE id = ?1)",
  )
    .bind(id, version)
    .run();
  if (!res.meta.changes) return false;
  await purgeVersionFiles(env, id, version);
  // 'purged' (not 'retired', which marks aborted uploads): the row keeps saying "this upload was committed".
  await env.DB.prepare("UPDATE artifact_versions SET status = 'purged' WHERE artifact_id = ? AND version = ? AND status = 'retiring'").bind(id, version).run();
  return true;
}

// ---------- uploads ----------

export async function beginUpload(
  env: Env,
  opts: { artifactId?: string; meta: ArtifactMeta; expected?: string[]; createdBy: string },
): Promise<UploadRow> {
  let artifactId = opts.artifactId;
  const isNew = !artifactId;
  if (artifactId) await requireArtifact(env, artifactId);
  else artifactId = crypto.randomUUID();

  let expected: string[] | null = null;
  if (opts.expected) {
    expected = [];
    for (const p of opts.expected) {
      const n = normalizePath(p);
      if (!n) throw new HttpError(400, 'invalid_path', `Invalid path: ${p}`);
      if (!isIgnoredPath(n)) expected.push(n); // junk is dropped on upload, so don't wait for it
    }
  }
  if (expected) expected = [...new Set(expected)]; // a path can be stored only once

  const t = now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions WHERE artifact_id = ?').bind(artifactId).first<{ v: number }>();
    const version = (row?.v ?? 0) + 1;
    const upload: UploadRow = {
      id: randomBase62(24),
      artifact_id: artifactId,
      version,
      is_new: isNew ? 1 : 0,
      meta: JSON.stringify(opts.meta),
      expected: null, // legacy column: older code JSON-parses it, so new sessions leave it NULL
      manifest: expected?.length ? 'pending' : null,
      created_by: opts.createdBy,
      created_at: t,
      expires_at: t + UPLOAD_TTL_SEC,
    };
    // Both rows are created together, and deletion can close the artifact before allocation.
    const active = 'EXISTS (SELECT 1 FROM artifacts WHERE id = ?3 AND deleted_at IS NULL)';
    try {
      const [allocated] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO artifact_versions (version, status, artifact_id, created_at, created_by, upload_id)
           SELECT ?1, ?2, ?3, ?4, ?5, ?7 WHERE ?6 OR ${active}`,
        ).bind(version, 'uploading', artifactId, t, opts.createdBy, upload.is_new, upload.id),
        env.DB.prepare(
          `INSERT INTO uploads (id, version, artifact_id, is_new, meta, expected, manifest, created_by, created_at, expires_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ?4 OR ${active}`,
        ).bind(upload.id, version, artifactId, upload.is_new, upload.meta, upload.expected, upload.manifest ?? null, upload.created_by, t, upload.expires_at),
      ]);
      if (!allocated.meta.changes) throw new HttpError(404, 'not_found', 'Artifact not found');
    } catch (e) {
      if (String(e).includes('UNIQUE')) continue;
      throw e;
    }
    // The session exists (marked 'pending', so it can't be committed yet, and the cleanup sweep only removes
    // manifest rows whose session is gone). Write the manifest once, then mark it complete with its size.
    if (expected?.length) {
      try {
        upload.manifest = `rows:${await insertExpected(env, upload.id, expected)}`;
        const marked = await env.DB.prepare("UPDATE uploads SET manifest = ? WHERE id = ? AND manifest = 'pending'").bind(upload.manifest, upload.id).run();
        // The session was removed while its list was being written (e.g. the artifact was deleted): don't hand
        // out an ID that no longer works, and don't leave the rows we just wrote behind.
        if (!marked.meta.changes) {
          await deleteExpected(env, upload.id).catch(() => {});
          // The client never received this upload ID; what happened is that the artifact went away.
          throw new HttpError(404, 'not_found', 'Artifact not found');
        }
      } catch (e) {
        await abortUpload(env, upload).catch(() => {});
        throw e;
      }
    }
    return upload;
  }
  throw new HttpError(409, 'conflict', 'Could not allocate a version number, retry');
}

/**
 * Writes a manifest as rows, in chunks that stay under D1's bound-parameter limit. Returns how many rows were
 * actually stored — the number the commit later checks against, so any paths the database folds together
 * can't look like a lost manifest.
 */
async function insertExpected(env: Env, uploadId: string, paths: string[]): Promise<number> {
  // Each statement carries a JSON array of paths (json_each expands it), chunked by size: a handful of
  // statements even for 10000 long paths — D1 counts every statement against a per-request query limit.
  const CHUNK_BYTES = 512 * 1024;
  const stmts: D1PreparedStatement[] = [];
  let part: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (!part.length) return;
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO upload_expected (upload_id, path) SELECT ?1, value FROM json_each(?2)').bind(uploadId, JSON.stringify(part)));
    part = [];
    bytes = 0;
  };
  const utf8 = new TextEncoder();
  for (const p of paths) {
    const size = utf8.encode(p).byteLength + 4; // plus JSON quoting/comma (paths have no control chars)
    if (bytes + size > CHUNK_BYTES) flush();
    part.push(p);
    bytes += size;
  }
  flush();
  let stored = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    for (const r of await env.DB.batch(stmts.slice(i, i + 50))) stored += r.meta.changes;
  }
  return stored;
}

export async function deleteExpected(env: Env, uploadId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM upload_expected WHERE upload_id = ?').bind(uploadId).run();
}

export async function requireUpload(env: Env, id: string): Promise<UploadRow> {
  const u = await env.DB.prepare('SELECT * FROM uploads WHERE id = ? AND expires_at > ?').bind(id, now()).first<UploadRow>();
  if (!u) throw await sessionGoneError(env, id); // committed → 409 upload_closed, for every route
  return u;
}

export type FileBody = ReadableStream | ArrayBuffer | Uint8Array | Blob | string;

export async function putUploadFile(env: Env, upload: UploadRow, rawPath: string, body: FileBody, settings: Settings, declaredSize?: number | null): Promise<{ path: string; size: number; ignored?: boolean }> {
  const path = normalizePath(rawPath);
  if (!path) throw new HttpError(400, 'invalid_path', `Invalid path: ${rawPath}`);
  // OS junk (__MACOSX/, .DS_Store, Thumbs.db) is accepted and dropped, same as direct and zip uploads.
  if (isIgnoredPath(path)) {
    if (body instanceof ReadableStream) await body.cancel();
    return { path, size: 0, ignored: true };
  }
  const size = typeof body === 'string' ? new TextEncoder().encode(body).byteLength
    : body instanceof Blob ? body.size
    : body instanceof ReadableStream ? declaredSize
    : body.byteLength;
  if (size == null || !Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'invalid_size', 'File size is required');
  if (size > settings.max_file_bytes) throw new HttpError(413, 'file_too_large', `${path} exceeds ${settings.max_file_bytes} bytes`);

  // Reserve this path before writing its object. Publishing checks the same reservations in D1.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO upload_writes (upload_id, path)
     SELECT u.id, ?2 FROM uploads u WHERE u.id = ?1 AND u.expires_at > ?3
       AND (EXISTS (SELECT 1 FROM artifact_files WHERE artifact_id = u.artifact_id AND version = u.version AND path = ?2)
         OR u.file_count < ?4)`,
  ).bind(upload.id, path, now(), settings.max_version_files).run();
  if (!claim.meta.changes) {
    if (!(await env.DB.prepare('SELECT 1 FROM uploads WHERE id = ? AND expires_at > ?').bind(upload.id, now()).first())) {
      throw await goneError(env, upload); // committed → 409 upload_closed; aborted or expired → 404
    }
    if (await env.DB.prepare('SELECT 1 FROM upload_writes WHERE upload_id = ? AND path = ?').bind(upload.id, path).first()) {
      throw new HttpError(409, 'file_busy', 'Another write is in progress for this path');
    }
    throw new HttpError(413, 'too_many_files', `At most ${settings.max_version_files} files per version`);
  }

  const key = r2Key(upload.artifact_id, upload.version, path);
  const contentType = contentTypeFor(path);
  let stored = false;
  try {
    const obj = await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
    if (!obj) throw new HttpError(500, 'storage_error', 'Failed to store file');
    stored = true;
    if (obj.size !== size) throw new HttpError(400, 'invalid_size', 'Stored file size differs from the request size');
    const [registered] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO artifact_files (artifact_id, version, path, size, content_type)
         SELECT artifact_id, version, ?2, ?3, ?4 FROM uploads WHERE id = ?1
         ON CONFLICT (artifact_id, version, path) DO UPDATE SET size = excluded.size, content_type = excluded.content_type`,
      ).bind(upload.id, path, obj.size, contentType),
      env.DB.prepare('UPDATE uploads SET revision = revision + 1 WHERE id = ?').bind(upload.id),
      env.DB.prepare('DELETE FROM upload_writes WHERE upload_id = ? AND path = ?').bind(upload.id, path),
    ]);
    if (!registered.meta.changes) {
      await env.BUCKET.delete(key);
      throw await goneError(env, upload);
    }
    return { path, size: obj.size };
  } catch (e) {
    // Once R2 has accepted a write, keep the reservation if its metadata transaction fails.
    // A commit must not publish an object with stale metadata. The upload can still be aborted.
    if (!stored) await env.DB.prepare('DELETE FROM upload_writes WHERE upload_id = ? AND path = ?').bind(upload.id, path).run();
    throw e;
  }
}

/** The preceding statement validated the file snapshot and marked this upload's version ready. */
const COMMIT_READY = `EXISTS (
  SELECT 1 FROM uploads u JOIN artifact_versions v ON v.artifact_id = u.artifact_id AND v.version = u.version
  WHERE u.id = ? AND v.status = 'ready'
)`;

/** The session was committed or aborted by a concurrent request: say which, instead of a misleading error. */
async function throwIfSessionGone(env: Env, upload: UploadRow): Promise<void> {
  if (await env.DB.prepare('SELECT 1 FROM uploads WHERE id = ?').bind(upload.id).first()) return;
  throw await goneError(env, upload);
}

/** sessionGoneError, plus a lookup by (artifact, version) for sessions begun before migration 0003. */
async function goneError(env: Env, upload: UploadRow): Promise<HttpError> {
  const e = await sessionGoneError(env, upload.id);
  if (e.code === 'upload_closed') return e;
  const v = await env.DB.prepare(
    `SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id AND a.deleted_at IS NULL
     WHERE v.artifact_id = ? AND v.version = ? AND v.status IN (${COMMITTED_STATES})`,
  )
    .bind(upload.artifact_id, upload.version)
    .first();
  return v ? new HttpError(409, 'upload_closed', 'This upload was already committed') : e;
}

/** Version states that mean "its upload was committed" (published, being cleaned up, or cleaned up). */
const COMMITTED_STATES = "'ready', 'retiring', 'purged'";

/**
 * Why an upload session no longer exists. A committed session's version stays 'ready' (or 'retiring' when
 * old versions are being cleaned up, 'purged' after): that is 409 upload_closed — the commit already happened, e.g. a retry
 * whose first response was lost — so clients must not upload again. Anything else is 404 upload_not_found.
 */
export async function sessionGoneError(env: Env, uploadId: string): Promise<HttpError> {
  // Only while the artifact still exists: once it is deleted the answer is 404, like everything else about it.
  const v = await env.DB.prepare(
    `SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id AND a.deleted_at IS NULL
     WHERE v.upload_id = ? AND v.status IN (${COMMITTED_STATES})`,
  )
    .bind(uploadId)
    .first();
  return v ? new HttpError(409, 'upload_closed', 'This upload was already committed') : new HttpError(404, 'upload_not_found', 'Upload session was aborted or expired');
}

export async function commitUpload(env: Env, upload: UploadRow, settings: Settings): Promise<ArtifactRow> {
  const [session, snapshot] = await env.DB.batch<{ revision: number; busy: number } | { path: string; size: number }>([
    env.DB.prepare('SELECT revision, EXISTS (SELECT 1 FROM upload_writes WHERE upload_id = uploads.id) AS busy FROM uploads WHERE id = ? AND expires_at > ?')
      .bind(upload.id, now()),
    env.DB.prepare('SELECT path, size FROM artifact_files WHERE artifact_id = ? AND version = ?').bind(upload.artifact_id, upload.version),
  ]);
  const state = session.results[0] as { revision: number; busy: number } | undefined;
  if (!state) {
    await throwIfSessionGone(env, upload); // committed by a concurrent request → upload_closed
    throw new HttpError(404, 'upload_not_found', 'Upload session was aborted or expired'); // row present but expired
  }
  if (state.busy) throw new HttpError(409, 'upload_busy', 'File writes are still in progress');
  const files = snapshot.results as { path: string; size: number }[];
  if (files.length === 0) throw new HttpError(400, 'empty_upload', 'No files were uploaded');
  if (files.length > settings.max_version_files) throw new HttpError(413, 'too_many_files', `At most ${settings.max_version_files} files per version`);
  const paths = files.map((f) => f.path);
  const pathSet = new Set(paths);

  if (upload.manifest === 'pending') throw new HttpError(409, 'upload_busy', 'The file list is still being saved; retry');
  if (upload.manifest?.startsWith('rows:')) {
    // Declared-but-missing files, checked in SQL against the manifest rows (never loaded whole). The row
    // count must match what was declared: fewer rows means the manifest was lost, not that nothing is missing.
    const declared = Number(upload.manifest.slice(5));
    const q = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id = ?').bind(upload.id),
      env.DB.prepare(
        'SELECT COUNT(*) AS n FROM upload_expected e WHERE e.upload_id = ?1 AND NOT EXISTS (SELECT 1 FROM artifact_files f WHERE f.artifact_id = ?2 AND f.version = ?3 AND f.path = e.path)',
      ).bind(upload.id, upload.artifact_id, upload.version),
      env.DB.prepare(
        'SELECT path FROM upload_expected e WHERE e.upload_id = ?1 AND NOT EXISTS (SELECT 1 FROM artifact_files f WHERE f.artifact_id = ?2 AND f.version = ?3 AND f.path = e.path) ORDER BY path LIMIT 5',
      ).bind(upload.id, upload.artifact_id, upload.version),
    ]);
    const missingCount = (q[1].results[0] as { n: number }).n;
    const countOff = (q[0].results[0] as { n: number }).n !== declared;
    // A concurrent commit or abort of this same session removes its manifest rows (and, for an abort, its
    // files) — report what actually happened, not a lost manifest / missing files.
    if (countOff || missingCount) await throwIfSessionGone(env, upload);
    if (countOff) {
      throw new HttpError(409, 'manifest_lost', 'The declared file list is incomplete; start the upload again');
    }
    if (missingCount) {
      const sample = (q[2].results as { path: string }[]).map((r) => r.path);
      throw new HttpError(400, 'missing_files', `Missing ${missingCount} file(s): ${sample.join(', ')}`);
    }
  } else if (upload.expected) {
    // Sessions started before the manifest moved to rows keep it as JSON.
    const missing = (JSON.parse(upload.expected) as string[]).filter((p) => !pathSet.has(p));
    if (missing.length) throw new HttpError(400, 'missing_files', `Missing ${missing.length} file(s): ${missing.slice(0, 5).join(', ')}`);
  }

  const meta = JSON.parse(upload.meta) as ArtifactMeta;
  const existing = upload.is_new ? null : await requireArtifact(env, upload.artifact_id);

  let entry: string | null = null;
  if (meta.entry) {
    if (!pathSet.has(meta.entry)) throw new HttpError(400, 'invalid_entry', `Entry file not found: ${meta.entry}`);
    entry = meta.entry;
  } else if (existing && pathSet.has(existing.entry)) {
    entry = existing.entry;
  } else {
    entry = inferEntry(paths);
  }
  if (!entry) throw new HttpError(400, 'entry_required', 'Could not determine the entry file; add index.html or pass `entry`');

  const kind = kindOf(paths);
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const t = now();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE artifact_versions SET status = 'ready', file_count = ?, total_size = ?, entry = ?, kind = ? WHERE artifact_id = ? AND version = ? AND status = 'uploading' AND EXISTS (
        SELECT 1 FROM uploads u WHERE u.id = ? AND u.revision = ? AND u.expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM upload_writes WHERE upload_id = u.id)
      )`,
    ).bind(files.length, totalSize, entry, kind, upload.artifact_id, upload.version, upload.id, state.revision, t),
  ];

  if (!existing) {
    // Defaults decide who can see a new artifact: read them fresh, not from the per-isolate cache.
    const defaults = meta.visibility === undefined || meta.indexable === undefined ? await getSettings(env, { fresh: true }) : settings;
    const visibility = meta.visibility ?? defaults.default_visibility;
    const passwordEnc = visibility === 'password' ? await encryptString(env.SECRET_KEY, randomAccessCode()) : null;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO artifacts (id, public_id, title, kind, visibility, password_enc, password_ver, indexable, entry, spa_fallback, current_version, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${COMMIT_READY}`,
      ).bind(
        upload.artifact_id,
        upload.artifact_id,
        meta.title ?? '',
        kind,
        visibility,
        passwordEnc,
        passwordEnc ? 1 : 0,
        (meta.indexable ?? defaults.default_indexable) ? 1 : 0,
        entry,
        meta.spa_fallback ? 1 : 0,
        upload.version,
        t,
        t,
        upload.id,
      ),
    );
  } else {
    const metaSql = await metaChanges(env, { title: meta.title, visibility: meta.visibility, spa_fallback: meta.spa_fallback, indexable: meta.indexable });
    stmts.push(
      // Only go live if newer: with concurrent uploads, an older version finishing last must not roll back.
      // Metadata sent with the content (title, visibility, ...) goes live in the *same* statement as the new
      // version — never new content under the old visibility, even briefly.
      env.DB.prepare(
        `UPDATE artifacts SET current_version = ?, kind = ?, entry = ?, updated_at = ?${metaSql.sets.map((x) => `, ${x}`).join('')} WHERE id = ? AND deleted_at IS NULL AND (current_version IS NULL OR current_version < ?) AND ${COMMIT_READY}`,
      ).bind(upload.version, kind, entry, t, ...metaSql.binds, upload.artifact_id, upload.version, upload.id),
    );
  }
  // Last: consuming the upload row is what makes the commit "win" against a concurrent abort.
  stmts.push(env.DB.prepare(`DELETE FROM uploads WHERE id = ? AND ${COMMIT_READY}`).bind(upload.id, upload.id));
  const results = await env.DB.batch(stmts);
  if (!results[0].meta.changes) {
    if (!(await env.DB.prepare('SELECT 1 FROM uploads WHERE id = ? AND expires_at > ?').bind(upload.id, now()).first())) {
      throw await goneError(env, upload); // a concurrent commit won → upload_closed
    }
    throw new HttpError(409, 'upload_busy', 'Files changed during commit; retry');
  }
  // Committed: the manifest has served its purpose (left-overs are swept by the daily cleanup).
  await deleteExpected(env, upload.id).catch(() => {});
  // The upload is stored (as a version in history) but a newer version is already live: the content and the
  // metadata sent with it did not take effect — say so instead of answering with the other version.
  if (existing && !results[1].meta.changes) {
    const live = await requireArtifact(env, upload.artifact_id);
    throw new HttpError(409, 'superseded', `Version ${upload.version} was stored, but newer version ${live.current_version} is live`, {
      version: upload.version,
      current_version: live.current_version,
    });
  }

  return requireArtifact(env, upload.artifact_id);
}

/**
 * Aborts an upload. The upload row goes first so in-flight writes fail their liveness check and clean up
 * after themselves; anything written before that is removed below. The version row is kept as 'aborted'
 * so its number is never handed out again (a late writer can't touch a later upload's files).
 */
export async function abortUpload(env: Env, upload: UploadRow): Promise<void> {
  const [del] = await env.DB.batch([
    env.DB.prepare("UPDATE artifact_versions SET status = 'aborted' WHERE artifact_id = ? AND version = ? AND status = 'uploading'").bind(upload.artifact_id, upload.version),
    env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(upload.id),
  ]).then((r) => [r[1]]);
  // Already committed (or aborted) by someone else: its files are live / gone — don't touch them.
  if (!del.meta.changes) return;
  await purgeVersionFiles(env, upload.artifact_id, upload.version);
  // The abort has already taken effect; leftover manifest rows are swept by the daily cleanup.
  await deleteExpected(env, upload.id).catch(() => {});
}

/** Picks the entry for a version being made live: keep the current entry if it exists there, else the version's own. */
export async function versionEntryAndKind(env: Env, a: ArtifactRow, version: number): Promise<{ entry: string; kind: string }> {
  const v = await env.DB.prepare("SELECT entry, kind FROM artifact_versions WHERE artifact_id = ? AND version = ? AND status = 'ready'")
    .bind(a.id, version)
    .first<{ entry: string | null; kind: string | null }>();
  if (!v) throw new HttpError(404, 'version_not_found', 'Version not found');
  const { results } = await env.DB.prepare('SELECT path FROM artifact_files WHERE artifact_id = ? AND version = ?').bind(a.id, version).all<{ path: string }>();
  const paths = results.map((r) => r.path);
  const entry = paths.includes(a.entry) ? a.entry : (v.entry ?? inferEntry(paths) ?? paths.find(isHtmlPath) ?? paths[0]);
  const kind = v.kind ?? kindOf(paths);
  return { entry, kind };
}

export interface IncomingFile {
  path: string;
  body: FileBody;
  size?: number;
}

/** One-shot upload used by the direct POST/PUT endpoints (raw HTML, multipart, zip). */
export async function uploadFiles(
  env: Env,
  files: IncomingFile[],
  opts: { artifactId?: string; meta: ArtifactMeta; createdBy: string; settings: Settings },
): Promise<ArtifactRow> {
  const kept = files.filter((f) => !isIgnoredPath(f.path));
  if (kept.length === 0) throw new HttpError(400, 'empty_upload', 'No files were uploaded');
  if (kept.length > opts.settings.max_version_files) throw new HttpError(413, 'too_many_files', `At most ${opts.settings.max_version_files} files per version`);
  const normalized = kept.map((f) => {
    const p = normalizePath(f.path);
    if (!p) throw new HttpError(400, 'invalid_path', `Invalid path: ${f.path}`);
    return p;
  });
  const { strip, paths } = stripCommonRoot(normalized);
  if (new Set(paths).size !== paths.length) throw new HttpError(400, 'duplicate_path', 'Duplicate file paths');
  const meta = { ...opts.meta };
  if (strip && meta.entry?.startsWith(strip)) meta.entry = meta.entry.slice(strip.length);

  const upload = await beginUpload(env, { artifactId: opts.artifactId, meta, createdBy: opts.createdBy });
  let i = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && i < kept.length) {
      const idx = i++;
      try {
        await putUploadFile(env, upload, paths[idx], kept[idx].body, opts.settings, kept[idx].size);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  // allSettled: on failure, wait for in-flight writes to finish before aborting so none outlive the abort.
  const results = await Promise.allSettled(Array.from({ length: Math.min(6, kept.length) }, worker));
  const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  try {
    if (err) throw err.reason;
    return await commitUpload(env, upload, opts.settings);
  } catch (e) {
    // commitUpload deletes the upload row in the same batch that publishes the version. If the row is
    // gone, the version is live and the error came afterwards — aborting would delete live content.
    const pending = await env.DB.prepare('SELECT 1 FROM uploads WHERE id = ?').bind(upload.id).first().catch(() => true);
    if (pending) await abortUpload(env, upload).catch(() => {});
    throw e;
  }
}
