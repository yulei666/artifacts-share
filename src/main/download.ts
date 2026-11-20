import type { Hono } from 'hono';
import type { ArtifactRow, Env } from '../env';
import { captchaRequired, verifyAccessCode } from '../lib/access';
import { signPayload, verifyPayload } from '../lib/crypto';
import { HttpError, now, readJsonObject } from '../lib/http';
import { getSettings } from '../lib/settings';
import { r2Key } from '../lib/store';
import { streamZip, type ZipFile } from '../lib/zipstream';
import type { AppContext, AppEnv } from './session';

/**
 * Downloads from the share page. What you get follows the artifact type, like Claude artifacts:
 * HTML and Markdown single-file artifacts download their source; folders download as ZIPs.
 *
 * Who may download: the owner always; visitors only when `visitor_download_enabled` is on (default off),
 * and for access-code artifacts only with a short-lived token obtained by entering the code.
 */

const TOKEN_TTL = 300;
interface DownloadToken { k: 'dl'; id: string; v: number; exp: number }

export type DownloadAccess = 'ok' | 'code' | 'denied';

/** `fresh`: read the setting from D1 (actual downloads); the share page's button display may use the 30 s cache. */
export async function downloadAccess(env: Env, a: ArtifactRow, owner: boolean, opts: { fresh?: boolean } = { fresh: true }): Promise<DownloadAccess> {
  if (owner) return 'ok';
  if (a.visibility === 'private') return 'denied';
  if (!(await getSettings(env, { fresh: !!opts.fresh })).visitor_download_enabled) return 'denied';
  return a.visibility === 'password' ? 'code' : 'ok';
}

/** Safe download file name from the title (falls back to `fallback`). */
function fileName(title: string, fallback: string, ext: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/\s+/g, ' ').trim();
  const base = Array.from(clean).slice(0, 100).join('') || fallback;
  return base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base}${ext}`;
}

/** `attachment` with an ASCII fallback name plus the exact UTF-8 one (RFC 6266). */
export function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 5987 attr-chars exclude ' ( ) * — encodeURIComponent leaves those, so escape them too.
  const ext = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

/** What the download button will produce (shown in its label). */
export async function downloadSummary(env: Env, a: ArtifactRow) {
  if (a.kind !== 'folder') {
    const f = await env.DB.prepare('SELECT size FROM artifact_files WHERE artifact_id = ? AND version = ? AND path = ?')
      .bind(a.id, a.current_version, a.entry)
      .first<{ size: number }>();
    const entryName = a.entry.split('/').pop()!;
    const ext = entryName.slice(entryName.lastIndexOf('.'));
    return { kind: a.kind, name: fileName(a.title, entryName.slice(0, -ext.length), ext), size: f?.size ?? 0, file_count: 1 };
  }
  const v = await env.DB.prepare('SELECT file_count, total_size FROM artifact_versions WHERE artifact_id = ? AND version = ?')
    .bind(a.id, a.current_version)
    .first<{ file_count: number; total_size: number }>();
  return { kind: 'zip' as const, name: fileName(a.title, 'artifact', '.zip'), size: v?.total_size ?? 0, file_count: v?.file_count ?? 0 };
}

/** `download` field of the viewer metadata. Code-protected visitors learn only the kind until they enter the code. */
export async function downloadInfo(env: Env, req: Request, a: ArtifactRow, owner: boolean) {
  const access = await downloadAccess(env, a, owner, { fresh: false });
  if (access === 'denied') return null;
  if (access === 'code') {
    const captcha = (await captchaRequired(env, req, a)) ? { turnstile_site_key: env.TURNSTILE_SITE_KEY } : {};
    return { kind: a.kind === 'folder' ? 'zip' : a.kind, needs_code: true, ...captcha };
  }
  return { ...(await downloadSummary(env, a)), needs_code: false };
}

export function registerDownloadRoutes(
  app: Hono<AppEnv>,
  viewable: (c: AppContext, publicId: string) => Promise<{ a: ArtifactRow; owner: boolean } | null>,
) {
  // Access-code visitors trade the code for a short-lived download token (keeps the code out of URLs).
  app.post('/api/public/artifacts/:pid/download-token', async (c) => {
    const v = await viewable(c, c.req.param('pid'));
    if (!v) throw new HttpError(404, 'not_found', 'Not found');
    const access = await downloadAccess(c.env, v.a, v.owner);
    if (access === 'denied') throw new HttpError(403, 'download_disabled', 'Downloads are not available');
    if (access === 'code') {
      const { code, turnstile_token } = await readJsonObject<{ code?: unknown; turnstile_token?: unknown }>(c.req.raw, { optional: true });
      const check = await verifyAccessCode(c.env, c.req.raw, v.a, typeof code === 'string' ? code : '', typeof turnstile_token === 'string' ? turnstile_token : null);
      if (!check.ok) {
        // Tell the popover whether the next attempt needs Turnstile (same counter as the unlock page).
        const captcha = (await captchaRequired(c.env, c.req.raw, v.a)) ? { turnstile_site_key: c.env.TURNSTILE_SITE_KEY } : {};
        if (check.reason === 'locked') throw new HttpError(429, 'rate_limited', 'Too many attempts, try again later', { retry_after: check.retryAfter });
        if (check.reason === 'turnstile') throw new HttpError(403, 'turnstile_required', 'Complete the verification first', captcha);
        throw new HttpError(403, 'incorrect_code', 'Incorrect access code', { remaining: check.remaining, ...captcha });
      }
    }
    const token = await signPayload(c.env.SECRET_KEY, { k: 'dl', id: v.a.public_id, v: v.a.password_ver, exp: now() + TOKEN_TTL } satisfies DownloadToken);
    return c.json({ token, ...(await downloadSummary(c.env, v.a)) });
  });

  app.get('/s/:pid/download', async (c) => {
    const v = await viewable(c, c.req.param('pid'));
    if (!v) throw new HttpError(404, 'not_found', 'Not found');
    const { a } = v;
    const access = await downloadAccess(c.env, a, v.owner);
    if (access === 'denied') throw new HttpError(403, 'download_disabled', 'Downloads are not available');
    if (access === 'code') {
      const t = await verifyPayload<DownloadToken>(c.env.SECRET_KEY, c.req.query('token'));
      // password_ver: regenerating the code invalidates outstanding tokens.
      if (!t || t.k !== 'dl' || t.id !== a.public_id || t.v !== a.password_ver || t.exp < now()) {
        throw new HttpError(403, 'download_code_required', 'Enter the access code to download');
      }
    }

    // `?check=1`: permission check only, as JSON — the share page runs it first, so a refusal shows up as an
    // error in the UI instead of the browser saving the error body as a "downloaded" file.
    if (c.req.query('check') === '1') return c.json({ ok: true });

    const summary = await downloadSummary(c.env, a);
    const headers = new Headers({
      'content-disposition': disposition(summary.name),
      // Never render downloaded content on the main origin.
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });

    if (summary.kind !== 'zip') {
      const obj = await c.env.BUCKET.get(r2Key(a.id, a.current_version!, a.entry));
      if (!obj) throw new HttpError(404, 'not_found', 'File not found');
      headers.set('content-type', 'application/octet-stream');
      headers.set('content-length', String(obj.size));
      return new Response(obj.body, { headers });
    }

    const { results } = await c.env.DB.prepare('SELECT path, size, content_type FROM artifact_files WHERE artifact_id = ? AND version = ? ORDER BY path')
      .bind(a.id, a.current_version)
      .all<ZipFile>();
    const ver = await c.env.DB.prepare('SELECT created_at FROM artifact_versions WHERE artifact_id = ? AND version = ?').bind(a.id, a.current_version).first<{ created_at: number }>();
    headers.set('content-type', 'application/zip');
    return new Response(streamZip(c.env, c.executionCtx, a.id, a.current_version!, results, new Date((ver?.created_at ?? now()) * 1000)), { headers });
  });
}
