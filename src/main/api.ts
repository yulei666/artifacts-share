import { Hono } from 'hono';
import type { ArtifactRow } from '../env';
import { isUuid } from '../lib/hosts';
import { disposition } from './download';
import { parseAnalyticsParams, queryAnalytics } from '../lib/analytics';
import { HttpError, now, readBodyLimited, readJsonObject } from '../lib/http';
import { getSettings, type Settings } from '../lib/settings';
import {
  abortUpload,
  artifactView,
  beginUpload,
  commitUpload,
  type IncomingFile,
  metaFromRequest,
  parseMeta,
  patchArtifact,
  purgeArtifact,
  putUploadFile,
  r2Key,
  regenerateLink,
  versionEntryAndKind,
  requireArtifact,
  requireUpload,
  softDeleteArtifact,
  uploadFiles,
} from '../lib/store';
import { extractZip } from '../lib/zip';
import { isIgnoredPath, normalizePath } from '../lib/paths';
import { actor, type AppContext, type AppEnv, requireAuth } from './session';

export const api = new Hono<AppEnv>();
api.use('*', requireAuth);


function idParam(c: AppContext): string {
  const id = c.req.param('id') ?? '';
  if (!isUuid(id)) throw new HttpError(404, 'not_found', 'Artifact not found');
  return id;
}

const readJson = <T = Record<string, unknown>>(c: AppContext) => readJsonObject<T>(c.req.raw);

/** `?version=` (default: the live one); anything but a positive integer is a 400. */
function versionParam(c: AppContext, current: number | null): number {
  const raw = c.req.query('version');
  if (raw === undefined) return current ?? 0;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw new HttpError(400, 'invalid_version', 'version must be a positive integer');
  return Number(raw);
}

/** Raw path after a route prefix, percent-decoded per segment. */
function wildcardPath(c: AppContext, marker: string): string {
  const pathname = new URL(c.req.url).pathname;
  const i = pathname.indexOf(marker);
  const rest = i >= 0 ? pathname.slice(i + marker.length) : '';
  try {
    return rest.split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new HttpError(400, 'invalid_path', 'Invalid path encoding');
  }
}

const view = (c: AppContext, a: ArtifactRow) => artifactView(c.env, a, new URL(c.req.url));

/** Whole multipart request cap: formData() buffers every part (use upload sessions for bigger folders). */
const MULTIPART_MAX_BYTES = 50 * 1024 * 1024;

/** Turns a direct-upload request body (HTML, multipart or zip) into files. */
async function filesFromRequest(c: AppContext, settings: Settings): Promise<{ files: IncomingFile[]; extraMeta: Record<string, unknown> }> {
  const ct = (c.req.header('content-type') ?? '').toLowerCase();
  const url = new URL(c.req.url);

  if (ct.startsWith('text/html') || ct.startsWith('text/plain') || ct.startsWith('text/markdown')) {
    const name = normalizePath(url.searchParams.get('filename') ?? url.searchParams.get('entry') ?? (ct.startsWith('text/markdown') ? 'index.md' : 'index.html'));
    if (!name) throw new HttpError(400, 'invalid_path', 'Invalid filename');
    // Never decode a big body into a JS string: stream it to R2 when the length is known, else read it under the cap.
    const len = c.req.header('content-length');
    if (len !== undefined && c.req.raw.body) {
      const size = Number(len);
      if (size === 0) throw new HttpError(400, 'empty_upload', 'Empty body');
      if (size > settings.max_file_bytes) throw new HttpError(413, 'file_too_large', `${name} exceeds ${settings.max_file_bytes} bytes`);
      return { files: [{ path: name, body: c.req.raw.body, size }], extraMeta: {} };
    }
    const bytes = await readBodyLimited(c.req.raw, settings.max_file_bytes);
    if (bytes.byteLength === 0) throw new HttpError(400, 'empty_upload', 'Empty body');
    return { files: [{ path: name, body: bytes, size: bytes.byteLength }], extraMeta: {} };
  }

  if (ct.startsWith('multipart/form-data')) {
    // formData() holds every part in memory: cap the whole request (bigger folders → upload sessions).
    const raw = await readBodyLimited(c.req.raw, MULTIPART_MAX_BYTES, 'request_too_large');
    const form = await new Response(raw, { headers: { 'content-type': c.req.header('content-type')! } }).formData().catch(() => {
      throw new HttpError(400, 'invalid_multipart', 'Malformed multipart body');
    });
    const files: IncomingFile[] = [];
    let extraMeta: Record<string, unknown> = {};
    for (const [field, value] of form.entries()) {
      if (typeof value === 'string') {
        if (field === 'meta') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            throw new HttpError(400, 'invalid_meta', 'meta must be JSON');
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_meta', 'meta must be a JSON object');
          extraMeta = { ...(parsed as Record<string, unknown>), ...extraMeta }; // explicit fields win, in any order
        } else if (['title', 'visibility', 'entry', 'spa_fallback', 'indexable', 'source_kind'].includes(field)) {
          extraMeta[field] = value;
        }
        continue;
      }
      files.push({ path: value.name, body: value, size: value.size });
    }
    return { files, extraMeta };
  }

  if (ct.startsWith('application/zip') || ct.startsWith('application/x-zip') || (ct.startsWith('application/octet-stream') && url.searchParams.get('format') === 'zip')) {
    if (!settings.server_unzip_enabled) {
      throw new HttpError(415, 'unzip_disabled', 'Server-side zip extraction is disabled; enable it in Settings or upload files individually');
    }
    // Request + extracted files all live in memory (128 MB isolate limit), hence the tight cap.
    const data = await readBodyLimited(c.req.raw, settings.unzip_max_bytes, 'zip_too_large');
    return { files: extractZip(data, settings), extraMeta: { source_kind: 'folder' } };
  }

  throw new HttpError(415, 'unsupported_media_type', 'Use text/html, text/markdown, multipart/form-data or application/zip');
}

async function directUpload(c: AppContext, artifactId?: string) {
  // One fresh snapshot for the whole request (zip switch, limits): a just-changed setting applies at once.
  const settings = await getSettings(c.env, { fresh: true });
  const { files, extraMeta } = await filesFromRequest(c, settings);
  const meta = { ...parseMeta(extraMeta), ...metaFromRequest(c.req.raw) };
  const a = await uploadFiles(c.env, files, { artifactId, meta, createdBy: actor(c), settings });
  return c.json(await view(c, a), artifactId ? 200 : 201);
}

// ---------- artifacts ----------

api.post('/artifacts', (c) => directUpload(c));

api.get('/artifacts', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 100);
  const q = c.req.query('q')?.trim();
  const vis = c.req.query('visibility');
  const cursor = c.req.query('cursor');
  const where = ['a.deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (q) {
    where.push("(a.title LIKE ? ESCAPE '\\' OR a.id LIKE ? ESCAPE '\\' OR a.public_id LIKE ? ESCAPE '\\')");
    const esc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
    const prefix = `${esc(q.toLowerCase())}%`;
    binds.push(`%${esc(q)}%`, prefix, prefix);
  }
  if (vis) {
    where.push('a.visibility = ?');
    binds.push(vis);
  }
  if (cursor) {
    let u: string, id: string;
    try {
      [u, id] = atob(cursor).split(':');
    } catch {
      throw new HttpError(400, 'invalid_cursor', 'Invalid cursor');
    }
    if (!/^\d+$/.test(u ?? '') || !id) throw new HttpError(400, 'invalid_cursor', 'Invalid cursor');
    where.push('(a.updated_at < ? OR (a.updated_at = ? AND a.id < ?))');
    binds.push(Number(u), Number(u), id);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, v.file_count, v.total_size FROM artifacts a
     LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.current_version
     WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<ArtifactRow & { file_count: number; total_size: number }>();
  const page = results.slice(0, limit);
  const ref = new URL(c.req.url);
  // No access codes in lists (fetch the artifact for it): no bulk decryption, no bulk exposure.
  const items = await Promise.all(
    page.map(async (r) => ({ ...(await artifactView(c.env, r, ref, { withPassword: false })), file_count: r.file_count, total_size: r.total_size })),
  );
  const last = page[page.length - 1];
  return c.json({ items, next_cursor: results.length > limit && last ? btoa(`${last.updated_at}:${last.id}`) : null });
});

api.get('/artifacts/:id', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const v = await c.env.DB.prepare('SELECT file_count, total_size FROM artifact_versions WHERE artifact_id = ? AND version = ?')
    .bind(a.id, a.current_version)
    .first<{ file_count: number; total_size: number }>();
  return c.json({ ...(await view(c, a)), file_count: v?.file_count ?? 0, total_size: v?.total_size ?? 0 });
});

api.patch('/artifacts/:id', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const meta = parseMeta(await readJson(c));
  return c.json(await view(c, await patchArtifact(c.env, a, meta)));
});

api.post('/artifacts/:id/password/reset', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  return c.json(await view(c, await patchArtifact(c.env, a, {}, { resetPassword: true })));
});

api.post('/artifacts/:id/regenerate-link', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const body = await readJsonObject<{ reset_password?: unknown }>(c.req.raw, { optional: true });
  return c.json(await view(c, await regenerateLink(c.env, a, { resetPassword: body.reset_password === true })));
});

api.put('/artifacts/:id/content', async (c) => {
  const id = idParam(c);
  await requireArtifact(c.env, id);
  return directUpload(c, id);
});

api.get('/artifacts/:id/versions', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const { results } = await c.env.DB.prepare(
    "SELECT version, file_count, total_size, created_at, created_by FROM artifact_versions WHERE artifact_id = ? AND status = 'ready' ORDER BY version DESC",
  )
    .bind(a.id)
    .all();
  return c.json({ current_version: a.current_version, items: results });
});

api.post('/artifacts/:id/versions/:v/activate', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const version = Number(c.req.param('v'));
  if (!Number.isInteger(version)) throw new HttpError(404, 'version_not_found', 'Version not found');
  const { entry, kind } = await versionEntryAndKind(c.env, a, version);
  // Guarded: the daily cleanup may retire this version between the check above and here.
  const res = await c.env.DB.prepare(
    "UPDATE artifacts SET current_version = ?1, entry = ?2, kind = ?3, updated_at = ?4 WHERE id = ?5 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM artifact_versions WHERE artifact_id = ?5 AND version = ?1 AND status = 'ready')",
  )
    .bind(version, entry, kind, now(), a.id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, 'version_not_found', 'Version not found');
  return c.json(await view(c, await requireArtifact(c.env, a.id)));
});

api.get('/artifacts/:id/files', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const version = versionParam(c, a.current_version);
  const { results } = await c.env.DB.prepare('SELECT path, size, content_type FROM artifact_files WHERE artifact_id = ? AND version = ? ORDER BY path')
    .bind(a.id, version)
    .all();
  return c.json({ version, items: results });
});

api.get('/artifacts/:id/files/*', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const path = normalizePath(wildcardPath(c, '/files/'));
  if (!path) throw new HttpError(400, 'invalid_path', 'Invalid path');
  const version = versionParam(c, a.current_version);
  const obj = await c.env.BUCKET.get(r2Key(a.id, version, path));
  if (!obj) throw new HttpError(404, 'file_not_found', 'File not found');
  // Never render user content on the admin origin.
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': disposition(path.split('/').pop()!),
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
});

api.delete('/artifacts/:id', async (c) => {
  const id = idParam(c);
  await requireArtifact(c.env, id);
  await softDeleteArtifact(c.env, id);
  c.executionCtx.waitUntil(purgeArtifact(c.env, id).catch((e) => console.error('purge failed', id, e)));
  return c.body(null, 204);
});

// ---------- analytics ----------

api.get('/analytics', async (c) => {
  const opts = parseAnalyticsParams(new URL(c.req.url));
  return c.json(await queryAnalytics(c.env, opts));
});

api.get('/artifacts/:id/analytics', async (c) => {
  const a = await requireArtifact(c.env, idParam(c));
  const opts = parseAnalyticsParams(new URL(c.req.url));
  return c.json(await queryAnalytics(c.env, { ...opts, artifact: a }));
});

// ---------- upload sessions ----------

api.post('/uploads', async (c) => {
  const body = await readJsonObject(c.req.raw, { maxBytes: 16 * 1024 * 1024 });
  let artifactId: string | undefined;
  if (body.artifact_id !== undefined && body.artifact_id !== null) {
    if (typeof body.artifact_id !== 'string' || !isUuid(body.artifact_id)) throw new HttpError(404, 'not_found', 'Artifact not found');
    artifactId = body.artifact_id;
  }
  let expected: string[] | undefined;
  if (Array.isArray(body.files)) {
    // OS junk is dropped on upload, so it doesn't count toward the limit either.
    expected = [...new Set(body.files.map((f) => (typeof f === 'string' ? f : String((f as { path?: unknown })?.path ?? ''))).filter((p) => !isIgnoredPath(p)))];
    const settings = await getSettings(c.env, { fresh: true });
    if (expected.length > settings.max_version_files) throw new HttpError(413, 'too_many_files', `At most ${settings.max_version_files} files per version`);
  }
  const meta = parseMeta(body);
  const u = await beginUpload(c.env, { artifactId, meta, expected, createdBy: actor(c) });
  return c.json({ upload_id: u.id, artifact_id: u.artifact_id, version: u.version, expires_at: u.expires_at }, 201);
});

api.put('/uploads/:uid/files/*', async (c) => {
  const u = await requireUpload(c.env, c.req.param('uid'));
  const settings = await getSettings(c.env, { fresh: true });
  const len = c.req.header('content-length');
  const size = len !== undefined ? Number(len) : null;
  // R2 needs a known length for streams; chunked bodies are buffered, but only up to the file-size limit.
  const body = size !== null && c.req.raw.body ? c.req.raw.body : await readBodyLimited(c.req.raw, settings.max_file_bytes);
  const res = await putUploadFile(c.env, u, wildcardPath(c, '/files/'), body, settings, size);
  return c.json(res);
});

api.post('/uploads/:uid/commit', async (c) => {
  // requireUpload answers 409 upload_closed for a session that was already committed (a retry whose first
  // response was lost), so the client doesn't upload the same content again.
  const u = await requireUpload(c.env, c.req.param('uid'));
  const a = await commitUpload(c.env, u, await getSettings(c.env, { fresh: true }));
  return c.json(await view(c, a), u.is_new ? 201 : 200);
});

api.delete('/uploads/:uid', async (c) => {
  const u = await requireUpload(c.env, c.req.param('uid'));
  await abortUpload(c.env, u);
  return c.body(null, 204);
});
