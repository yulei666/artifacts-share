import type { ArtifactRow, Env } from '../env';
import { isHtmlPath } from '../lib/mime';
import { requestPathToKey } from '../lib/paths';
import { localPath } from '../lib/http';
import { r2Key } from '../lib/store';

const EDGE_CACHE_MAX_BYTES = 5 * 1024 * 1024;

function baseHeaders(a: ArtifactRow, isPublic: boolean, ancestors: string): Headers {
  const h = new Headers({
    // Only the main domain's viewer (and the artifact itself) may frame content.
    'content-security-policy': `frame-ancestors ${ancestors}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    // Browsers revalidate every load (cheap 304 via ETag), so making an artifact private takes effect at once;
    // the edge copy (s-maxage) is only consulted after the gateway's access check.
    'cache-control': isPublic ? 'public, max-age=0, must-revalidate, s-maxage=60' : 'private, no-store',
  });
  if (!(isPublic && a.indexable)) h.set('x-robots-tag', 'noindex, nofollow, noarchive');
  return h;
}

function rangeHeader(range: R2Range, size: number): string {
  const r = range as { offset?: number; length?: number; suffix?: number };
  let start: number;
  let end: number;
  if (r.suffix !== undefined) {
    start = Math.max(0, size - r.suffix);
    end = size - 1;
  } else {
    start = r.offset ?? 0;
    end = r.length !== undefined ? start + r.length - 1 : size - 1;
  }
  end = Math.min(end, size - 1); // a range past the end is served up to the last byte
  return `bytes ${start}-${end}/${size}`;
}

function failsStrictPrecondition(req: Request, obj: R2Object): boolean {
  const ifMatch = req.headers.get('if-match');
  if (ifMatch && ifMatch.trim() !== '*') {
    const tags = ifMatch.split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (!tags.includes(obj.httpEtag)) return true;
  }
  const ius = req.headers.get('if-unmodified-since');
  if (!ifMatch && ius) {
    const since = Date.parse(ius);
    if (!Number.isNaN(since) && Math.floor(obj.uploaded.getTime() / 1000) > Math.floor(since / 1000)) return true;
  }
  return false;
}

function plain(status: number, text: string, a: ArtifactRow, ancestors: string): Response {
  const h = baseHeaders(a, false, ancestors);
  h.set('content-type', 'text/plain; charset=utf-8');
  return new Response(text, { status, headers: h });
}

export async function serveFile(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  a: ArtifactRow,
  opts: { isPublic: boolean; ancestors: string; countView: boolean },
): Promise<Response> {
  const { isPublic, ancestors } = opts;
  const url = new URL(req.url);
  const key = requestPathToKey(url.pathname);
  if (key === null) return plain(400, 'Bad path', a, ancestors);
  const version = a.current_version!;
  // An entry in a subdirectory must be served at its own URL, or its relative links resolve against `/`.
  if (key === '' && a.entry.includes('/')) {
    const location = '/' + a.entry.split('/').map(encodeURIComponent).join('/') + url.search;
    return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
  }
  const trailing = url.pathname.endsWith('/') && key !== '';
  const path = key === '' ? a.entry : trailing ? `${key}/index.html` : key;
  const isHead = req.method === 'HEAD';

  // A view = a successful HTML page load (top-level, or in the share page's iframe), counted where a 200 HTML
  // response is actually sent — including edge-cache hits and SPA fallbacks; not 404s or redirects.
  const dest = req.headers.get('sec-fetch-dest');
  const countView = () => {
    if (opts.countView && !isHead && (!dest || dest === 'document' || dest === 'iframe')) {
      ctx.waitUntil(env.DB.prepare('UPDATE artifacts SET view_count = view_count + 1 WHERE id = ?').bind(a.id).run().catch(() => {}));
    }
  };

  const cacheable = isPublic && req.method === 'GET' && !req.headers.has('range');
  // `indexable` changes response headers, so it is part of the key.
  const cacheKey = new Request(`${url.origin}/__cache/v${version}/i${a.indexable}/${path.split('/').map(encodeURIComponent).join('/')}`);
  if (cacheable) {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const inm = req.headers.get('if-none-match');
      if (inm && inm === hit.headers.get('etag')) {
        await hit.body?.cancel();
        return new Response(null, { status: 304, headers: hit.headers });
      }
      if (isHtmlPath(path)) countView();
      return hit;
    }
  }

  let obj: R2Object | R2ObjectBody | null;
  try {
    // HEAD only needs metadata; get() would open the whole object body.
    obj = isHead ? await env.BUCKET.head(r2Key(a.id, version, path)) : await env.BUCKET.get(r2Key(a.id, version, path), { range: req.headers, onlyIf: req.headers });
  } catch (e) {
    // R2 rejects an unsatisfiable Range; anything else is a real storage error, not the client's fault.
    if (req.headers.has('range')) return plain(416, 'Range not satisfiable', a, ancestors);
    console.error('R2 read failed', a.id, path, e);
    return plain(500, 'Storage error', a, ancestors);
  }
  let status = 200;
  let servedPath = path;

  if (!obj) {
    if (!trailing && key !== '' && (await env.BUCKET.head(r2Key(a.id, version, `${key}/index.html`)))) {
      return new Response(null, { status: 301, headers: { location: `${localPath(url.pathname)}/${url.search}`, 'cache-control': 'no-store' } });
    }
    const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html') || !/\.[a-z0-9]+$/i.test(path);
    if (a.spa_fallback && wantsHtml) {
      obj = isHead ? await env.BUCKET.head(r2Key(a.id, version, a.entry)) : await env.BUCKET.get(r2Key(a.id, version, a.entry));
      servedPath = a.entry;
    } else {
      obj = isHead ? await env.BUCKET.head(r2Key(a.id, version, '404.html')) : await env.BUCKET.get(r2Key(a.id, version, '404.html'));
      servedPath = '404.html';
      status = 404;
    }
    if (!obj) return plain(404, 'Not found', a, ancestors);
  }

  const headers = baseHeaders(a, isPublic, ancestors);
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');

  if (isHead) {
    const inm = req.headers.get('if-none-match');
    headers.set('content-length', String(obj.size));
    return new Response(null, { status: inm && inm === obj.httpEtag ? 304 : status, headers });
  }
  if (!('body' in obj)) {
    // A precondition failed. RFC 9110 evaluates If-Match / If-Unmodified-Since first (→ 412), then
    // If-None-Match / If-Modified-Since (→ 304); check the former ourselves to tell which one it was.
    return new Response(null, { status: failsStrictPrecondition(req, obj) ? 412 : 304, headers });
  }

  if (status === 200 && req.headers.has('range') && obj.range) {
    status = 206;
    headers.set('content-range', rangeHeader(obj.range, obj.size));
  }

  if (status === 200 && isHtmlPath(servedPath)) countView();
  const res = new Response((obj as R2ObjectBody).body, { status, headers });
  // Only small files go to the edge cache: clone() tees the body, and for a big file sent to a slow client the
  // runtime would buffer the difference in memory (128 MB isolate).
  if (cacheable && status === 200 && servedPath === path && obj.size <= EDGE_CACHE_MAX_BYTES) ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}
