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
  expected: string | null;
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
async function metaChanges(env: Env, a: ArtifactRow, meta: ArtifactMeta, opts: { resetPassword?: boolean } = {}): Promise<{ sets: string[]; binds: unknown[] }> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), binds.push(v));
  if (meta.title !== undefined) set('title', meta.title);
  if (meta.spa_fallback !== undefined) set('spa_fallback', meta.spa_fallback ? 1 : 0);
  if (meta.indexable !== undefined) set('indexable', meta.indexable ? 1 : 0);
  if (meta.entry !== undefined) set('entry', meta.entry);
  if (meta.visibility !== undefined) set('visibility', meta.visibility);
  const nextVis = meta.visibility ?? a.visibility;
  const entering = nextVis === 'password' && a.visibility !== 'password';
  if (nextVis === 'password' && (entering || !a.password_enc || opts.resetPassword)) {
    set('password_enc', await encryptString(env.SECRET_KEY, randomAccessCode()));
    sets.push('password_ver = password_ver + 1');
  } else if (opts.resetPassword) {
    throw new HttpError(400, 'not_password_protected', 'Artifact is not in password mode');
  }
  return { sets, binds };
}

export async function patchArtifact(env: Env, a: ArtifactRow, meta: ArtifactMeta, opts: { resetPassword?: boolean } = {}): Promise<ArtifactRow> {
  if (meta.entry !== undefined) {
    const exists = await env.DB.prepare('SELECT 1 FROM artifact_files WHERE artifact_id = ? AND version = ? AND path = ?').bind(a.id, a.current_version, meta.entry).first();
    if (!exists) throw new HttpError(400, 'invalid_entry', `Entry file not found: ${meta.entry}`);
  }
  const { sets, binds } = await metaChanges(env, a, meta, opts);
  sets.push('updated_at = ?');
  binds.push(now());
  await env.DB.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, a.id).run();
  return requireArtifact(env, a.id);
}

/**
 * Gives the artifact a new subdomain; the old link stops working immediately.
 * Optionally regenerates the access code as well.
 */
export async function regenerateLink(env: Env, a: ArtifactRow, opts: { resetPassword?: boolean } = {}): Promise<ArtifactRow> {
  if (opts.resetPassword && a.visibility !== 'password') throw new HttpError(400, 'not_password_protected', 'Artifact is not in password mode');
  const publicId = crypto.randomUUID();
  if (opts.resetPassword) {
    await env.DB.prepare('UPDATE artifacts SET public_id = ?, password_enc = ?, password_ver = password_ver + 1, updated_at = ? WHERE id = ?')
      .bind(publicId, await encryptString(env.SECRET_KEY, randomAccessCode()), now(), a.id)
      .run();
  } else {
    await env.DB.prepare('UPDATE artifacts SET public_id = ?, updated_at = ? WHERE id = ?').bind(publicId, now(), a.id).run();
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
  await env.DB.prepare('DELETE FROM uploads WHERE artifact_id = ?').bind(id).run();
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
 * Deletes an old version unless it is (or just became) the live one. The version row goes first, guarded
 * against current_version in the same statement: once it's gone, a rollback to it fails with 404 instead of
 * pointing current_version at files being deleted. Returns false when the version was live and kept.
 */
export async function retireVersion(env: Env, id: string, version: number): Promise<boolean> {
  // 'retiring' first (guarded against the live version): it can no longer be activated, and if purging fails
  // the row is still there for the daily cleanup to retry. The row goes only after its files are gone.
  const res = await env.DB.prepare(
    "UPDATE artifact_versions SET status = 'retiring' WHERE artifact_id = ?1 AND version = ?2 AND status IN ('ready', 'retiring') AND version IS NOT (SELECT current_version FROM artifacts WHERE id = ?1)",
  )
    .bind(id, version)
    .run();
  if (!res.meta.changes) return false;
  await purgeVersionFiles(env, id, version);
  await env.DB.prepare("DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ? AND status = 'retiring'").bind(id, version).run();
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

  const t = now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions WHERE artifact_id = ?').bind(artifactId).first<{ v: number }>();
    const version = (row?.v ?? 0) + 1;
    try {
      await env.DB.prepare('INSERT INTO artifact_versions (artifact_id, version, status, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .bind(artifactId, version, 'uploading', t, opts.createdBy)
        .run();
    } catch (e) {
      if (String(e).includes('UNIQUE')) continue; // concurrent upload took this version number
      throw e;
    }
    const upload: UploadRow = {
      id: randomBase62(24),
      artifact_id: artifactId,
      version,
      is_new: isNew ? 1 : 0,
      meta: JSON.stringify(opts.meta),
      expected: expected ? JSON.stringify(expected) : null,
      created_by: opts.createdBy,
      created_at: t,
      expires_at: t + UPLOAD_TTL_SEC,
    };
    await env.DB.prepare('INSERT INTO uploads (id, artifact_id, version, is_new, meta, expected, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(upload.id, upload.artifact_id, upload.version, upload.is_new, upload.meta, upload.expected, upload.created_by, upload.created_at, upload.expires_at)
      .run();
    return upload;
  }
  throw new HttpError(409, 'conflict', 'Could not allocate a version number, retry');
}

export async function requireUpload(env: Env, id: string): Promise<UploadRow> {
  const u = await env.DB.prepare('SELECT * FROM uploads WHERE id = ? AND expires_at > ?').bind(id, now()).first<UploadRow>();
  if (!u) throw new HttpError(404, 'upload_not_found', 'Upload session not found or expired');
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
  if (declaredSize != null && declaredSize > settings.max_file_bytes) throw new HttpError(413, 'file_too_large', `${path} exceeds ${settings.max_file_bytes} bytes`);

  // A published (or aborted) version is immutable: refuse before touching R2.
  // One round trip: is the version still open, and does this path already exist in it?
  const state = await env.DB.prepare(
    'SELECT v.status, EXISTS (SELECT 1 FROM artifact_files f WHERE f.artifact_id = v.artifact_id AND f.version = v.version AND f.path = ?) AS known FROM artifact_versions v WHERE v.artifact_id = ? AND v.version = ?',
  )
    .bind(path, upload.artifact_id, upload.version)
    .first<{ status: string; known: number }>();
  if (state?.status !== 'uploading') throw new HttpError(409, 'upload_closed', 'This upload was already committed or aborted');

  // File-count limit with O(1) reads per file: a PK lookup for "new path?" plus a guarded counter increment
  // on the upload row (no COUNT(*) over the whole version for every file).
  const known = !!state.known;
  let slotTaken = false;
  const releaseSlot = async () => {
    if (!slotTaken) return;
    slotTaken = false;
    await env.DB.prepare('UPDATE uploads SET file_count = MAX(file_count - 1, 0) WHERE id = ?').bind(upload.id).run();
  };
  if (!known) {
    const slot = await env.DB.prepare('UPDATE uploads SET file_count = file_count + 1 WHERE id = ? AND file_count < ? RETURNING file_count')
      .bind(upload.id, settings.max_version_files)
      .first();
    if (!slot) {
      const exists = await env.DB.prepare('SELECT 1 FROM uploads WHERE id = ?').bind(upload.id).first();
      if (!exists) throw new HttpError(404, 'upload_not_found', 'Upload session was aborted');
      throw new HttpError(413, 'too_many_files', `At most ${settings.max_version_files} files per version`);
    }
    slotTaken = true;
  }

  const key = r2Key(upload.artifact_id, upload.version, path);
  const contentType = contentTypeFor(path);
  let obj: R2Object | null;
  try {
    obj = await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
    if (!obj) throw new HttpError(500, 'storage_error', 'Failed to store file');
    if (obj.size > settings.max_file_bytes) {
      await env.BUCKET.delete(key);
      throw new HttpError(413, 'file_too_large', `${path} exceeds ${settings.max_file_bytes} bytes`);
    }
  } catch (e) {
    await releaseSlot(); // a failed write (or a retry later) must not use up the file limit
    throw e;
  }
  // INSERT OR IGNORE tells a new path from an existing one: if a parallel PUT of the same path got there
  // first, give our slot back so one path never counts twice.
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO artifact_files (artifact_id, version, path, size, content_type) VALUES (?, ?, ?, ?, ?)')
    .bind(upload.artifact_id, upload.version, path, obj.size, contentType)
    .run();
  if (!ins.meta.changes) {
    await releaseSlot();
    await env.DB.prepare('UPDATE artifact_files SET size = ?, content_type = ? WHERE artifact_id = ? AND version = ? AND path = ?')
      .bind(obj.size, contentType, upload.artifact_id, upload.version, path)
      .run();
  }
  // The session may have been committed or aborted while this file was in flight (after the check above).
  const alive = await env.DB.prepare('SELECT 1 FROM uploads WHERE id = ?').bind(upload.id).first();
  if (!alive) {
    const committed = await env.DB.prepare("SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND version = ? AND status = 'ready'").bind(upload.artifact_id, upload.version).first();
    // Committed while this file was in flight: never delete from a published version — the commit may have
    // listed this very file (its row can land before the commit reads the file list). At worst the version
    // has one extra file not counted in its stats. Aborted: remove what we wrote.
    if (!committed) {
      await env.BUCKET.delete(key);
      await env.DB.prepare('DELETE FROM artifact_files WHERE artifact_id = ? AND version = ? AND path = ?').bind(upload.artifact_id, upload.version, path).run();
    }
    throw committed ? new HttpError(409, 'upload_closed', 'This upload was already committed') : new HttpError(404, 'upload_not_found', 'Upload session was aborted');
  }
  return { path, size: obj.size };
}

/** SQL guard: the upload session still exists (bind its id). A D1 batch is one transaction, so commit and abort can't both win. */
const PENDING = 'EXISTS (SELECT 1 FROM uploads WHERE id = ?)';

export async function commitUpload(env: Env, upload: UploadRow, settings: Settings): Promise<ArtifactRow> {
  const { results: files } = await env.DB.prepare('SELECT path, size FROM artifact_files WHERE artifact_id = ? AND version = ?')
    .bind(upload.artifact_id, upload.version)
    .all<{ path: string; size: number }>();
  if (files.length === 0) throw new HttpError(400, 'empty_upload', 'No files were uploaded');
  if (files.length > settings.max_version_files) throw new HttpError(413, 'too_many_files', `At most ${settings.max_version_files} files per version`);
  const paths = files.map((f) => f.path);
  const pathSet = new Set(paths);

  if (upload.expected) {
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
      `UPDATE artifact_versions SET status = 'ready', file_count = ?, total_size = ?, entry = ?, kind = ? WHERE artifact_id = ? AND version = ? AND status = 'uploading' AND ${PENDING}`,
    ).bind(files.length, totalSize, entry, kind, upload.artifact_id, upload.version, upload.id),
  ];

  if (!existing) {
    // Defaults decide who can see a new artifact: read them fresh, not from the per-isolate cache.
    const defaults = meta.visibility === undefined || meta.indexable === undefined ? await getSettings(env, { fresh: true }) : settings;
    const visibility = meta.visibility ?? defaults.default_visibility;
    const passwordEnc = visibility === 'password' ? await encryptString(env.SECRET_KEY, randomAccessCode()) : null;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO artifacts (id, public_id, title, kind, visibility, password_enc, password_ver, indexable, entry, spa_fallback, current_version, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${PENDING}`,
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
    const metaSql = await metaChanges(env, existing, { title: meta.title, visibility: meta.visibility, spa_fallback: meta.spa_fallback, indexable: meta.indexable });
    stmts.push(
      // Only go live if newer: with concurrent uploads, an older version finishing last must not roll back.
      // Metadata sent with the content (title, visibility, ...) goes live in the *same* statement as the new
      // version — never new content under the old visibility, even briefly.
      env.DB.prepare(
        `UPDATE artifacts SET current_version = ?, kind = ?, entry = ?, updated_at = ?${metaSql.sets.map((x) => `, ${x}`).join('')} WHERE id = ? AND (current_version IS NULL OR current_version < ?) AND ${PENDING}`,
      ).bind(upload.version, kind, entry, t, ...metaSql.binds, upload.artifact_id, upload.version, upload.id),
    );
  }
  // Last: consuming the upload row is what makes the commit "win" against a concurrent abort.
  stmts.push(env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(upload.id));
  const results = await env.DB.batch(stmts);
  if (!results[results.length - 1].meta.changes) throw new HttpError(404, 'upload_not_found', 'Upload session was aborted');
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
