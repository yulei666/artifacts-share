import { MARKDOWN_PREVIEW_MAX_BYTES, MARKDOWN_RAW_PARAM, markdownEtag, markdownObjectEtag, markdownPage } from './markdown';
import type { PageCtx } from './pages';
import type { ArtifactRow, Env } from '../env';
import { contentTypeFor, isHtmlPath, isMarkdownPath } from '../lib/mime';
import { requestPathToKey } from '../lib/paths';
import { localPath } from '../lib/http';
import { r2Key } from '../lib/store';
import { analyticsEnabled, recordView, shouldCountView } from '../lib/analytics';
import { MARKDOWN_INDEX_MAX_LENGTH, pickMarkdownIndex } from '../../web/markdown-index.js';

const PUBLIC_BROWSER_CACHE = 'private, max-age=0, must-revalidate';
const EDGE_CACHE_MAX_BYTES = 5 * 1024 * 1024;

function baseHeaders(a: ArtifactRow, isPublic: boolean, ancestors: string): Headers {
  const h = new Headers({
    // Only the main domain's viewer (and the artifact itself) may frame content.
    'content-security-policy': `frame-ancestors ${ancestors}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    // Browsers revalidate every load (cheap 304 via ETag), so making an artifact private takes effect at once;
    // shared caches must go through the gateway; its internal Cache API copy has separate headers.
    'cache-control': isPublic ? PUBLIC_BROWSER_CACHE : 'private, no-store',
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

function matchesEtag(value: string, etag: string | null, weak = false): boolean {
  return value.trim() === '*' || value.split(',').some((tag) => {
    const trimmed = tag.trim();
    return (weak ? trimmed.replace(/^W\//, '') : trimmed) === etag;
  });
}

/**
 * Whether an Accept header prefers HTML over the Markdown source: text/html must be acceptable and rank above
 * text/markdown / text/plain (by q, then by listing order). A wildcard alone is not a preference for HTML.
 */
export function prefersHtml(accept: string | null): boolean {
  const ranked = (accept ?? '').split(',').map((part, index) => {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    return { type: type.trim(), q: Number.isFinite(weight) ? weight : 0, index };
  });
  const html = ranked.find((r) => r.type === 'text/html');
  if (!html || html.q <= 0) return false;
  return !ranked.some((r) => (r.type === 'text/markdown' || r.type === 'text/plain' || r.type === 'text/x-markdown')
    && (r.q > html.q || (r.q === html.q && r.index < html.index)));
}

/** The last path segment has a dot-extension of a known file type (a missing asset rather than a directory). */
function looksLikeFile(key: string): boolean {
  const last = key.slice(key.lastIndexOf('/') + 1);
  return last.lastIndexOf('.') > 0 && contentTypeFor(last) !== 'application/octet-stream';
}

function preconditionStatus(req: Request, obj: R2Object): 304 | 412 | null {
  const modified = Math.floor(obj.uploaded.getTime() / 1000);
  const date = (name: string) => Math.floor(Date.parse(req.headers.get(name) ?? '') / 1000);
  const ifMatch = req.headers.get('if-match');
  if (ifMatch ? !matchesEtag(ifMatch, obj.httpEtag) : modified > date('if-unmodified-since')) return 412;
  const ifNoneMatch = req.headers.get('if-none-match');
  if (ifNoneMatch ? matchesEtag(ifNoneMatch, obj.httpEtag, true) : modified <= date('if-modified-since')) return 304;
  return null;
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
  opts: PageCtx & { isPublic: boolean; countView: boolean },
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
  const markdown = isMarkdownPath(path);
  const rawMarkdown = url.searchParams.get(MARKDOWN_RAW_PARAM);
  const plainMarkdown = rawMarkdown === 'plain';

  // A view = a successful HTML page load (top-level, or in the share page's iframe), counted where a 200 HTML
  // response is actually sent — including edge-cache hits and SPA fallbacks; not 404s or redirects.
  const dest = req.headers.get('sec-fetch-dest');
  const countView = (servedPath: string, bytes: number) => {
    if (opts.countView && !isHead && (!dest || dest === 'document' || dest === 'iframe')) {
      // When Analytics Engine is configured, avoid D1 writes on every page load (counts come from WAE 90d queries).
      if (!analyticsEnabled(env) && shouldCountView(req)) {
        ctx.waitUntil(env.DB.prepare('UPDATE artifacts SET view_count = view_count + 1 WHERE id = ?').bind(a.id).run().catch(() => {}));
      }
      recordView(env, ctx, req, a, servedPath, bytes);
    }
  };

  // Browser page loads get the reader for *any* Markdown file (so a README's relative link to guide.md also
  // renders). Everything else — curl, scripts, agents, fetch() — gets the raw file: without Sec-Fetch-Dest
  // (older browsers, non-browser clients) only an Accept that asks for HTML counts as a page load.
  const pageLoad = dest === 'document' || dest === 'iframe' || (!dest && prefersHtml(req.headers.get('accept')));
  // A reader response carries its source from the same authorized version snapshot.
  if (markdown && rawMarkdown === null && pageLoad && !req.headers.has('range')) {
    const objectKey = r2Key(a.id, version, path);
    // A reader validator from this shell and language names the object ETag it was built from; R2 checks it in
    // the same GET (no body when it still matches), so a revalidation costs one operation either way.
    const known = markdownObjectEtag(req.headers.get('if-none-match'), opts.lang);
    const object = isHead
      ? await env.BUCKET.head(objectKey)
      : await env.BUCKET.get(objectKey, known ? { onlyIf: { etagDoesNotMatch: known } } : undefined);
    if (object) {
      const etag = markdownEtag(object.httpEtag, opts.lang);
      const headers = baseHeaders(a, isPublic, ancestors);
      const body = 'body' in object ? object as R2ObjectBody : null;
      if (known && object.etag === known && (isHead || !body)) return markdownPage(req, opts, headers, null, etag, true);
      let source: string | null = null;
      if (body) {
        if (body.size <= MARKDOWN_PREVIEW_MAX_BYTES) source = await body.text();
        else await body.body.cancel();
      }
      countView(path, body?.size ?? 0);
      return markdownPage(req, opts, headers, source, etag);
    }
  }

  const conditional = ['if-match', 'if-unmodified-since', 'if-modified-since', 'if-range'].some((name) => req.headers.has(name));
  const cacheable = isPublic && req.method === 'GET' && !req.headers.has('range') && !conditional;
  // `indexable` changes response headers, so it is part of the key.
  const cacheKey = new Request(`${url.origin}/__cache/v${version}/i${a.indexable}${markdown ? (plainMarkdown ? '-markdown-plain' : '-markdown') : ''}/${path.split('/').map(encodeURIComponent).join('/')}`);
  if (cacheable) {
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const inm = req.headers.get('if-none-match');
      const headers = new Headers(hit.headers);
      headers.set('cache-control', PUBLIC_BROWSER_CACHE);
      const etag = headers.get('etag');
      if (inm && matchesEtag(inm, etag, true)) {
        await hit.body?.cancel();
        return new Response(null, { status: 304, headers });
      }
      if (isHtmlPath(path)) countView(path, Number(headers.get('content-length') ?? 0) || 0);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  let rangeApplied = false;
  const load = async (file: string, allowRange: boolean): Promise<R2Object | R2ObjectBody | null> => {
    const objectKey = r2Key(a.id, version, file);
    if (isHead) return env.BUCKET.head(objectKey);
    let range: Headers | undefined = allowRange && req.headers.has('range') ? req.headers : undefined;
    const ifRange = req.headers.get('if-range');
    if (range && ifRange) {
      const current = await env.BUCKET.head(objectKey);
      if (!current) return null;
      // Only an ETag is a strong validator here: publishing another version can happen in the same second.
      if (ifRange !== current.httpEtag) range = undefined;
    }
    rangeApplied = range !== undefined;
    return env.BUCKET.get(objectKey, { range });
  };
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await load(path, true);
  } catch (e) {
    if (req.headers.has('range') && (e instanceof Error && /range|satisfiable/i.test(e.message))) return plain(416, 'Range not satisfiable', a, ancestors);
    console.error('R2 read failed', a.id, path, e);
    return plain(500, 'Storage error', a, ancestors);
  }
  let status = 200;
  let servedPath = path;

  if (!obj) {
    if (!trailing && key !== '' && (await env.BUCKET.head(r2Key(a.id, version, `${key}/index.html`)))) {
      return new Response(null, { status: 301, headers: { location: `${localPath(url.pathname)}/${url.search}`, 'cache-control': 'no-store' } });
    }
    // A Markdown folder's directory URL (`guide/` or `guide`) opens its index.md or README.md, like the entry.
    // One D1 lookup covers every candidate. A known file extension means a missing asset, not a directory;
    // dotted directory names (`v1.2`) still qualify.
    // HTML SPAs keep their client-side routes (no extra lookup, no redirect away from the app).
    if (key !== '' && a.kind === 'folder' && (isMarkdownPath(a.entry) || !a.spa_fallback) && (trailing || !looksLikeFile(key))) {
      // SQLite's lower() folds only ASCII and substr() counts code points, so match the directory exactly by
      // code-point length and compare the (short, direct-child) file names in JS.
      const dir = `${key}/`;
      const dirLength = [...dir].length;
      const { results } = await env.DB.prepare(
        // `path >= dir AND path < dir-with-'/'-bumped-to-'0'` is an index range on the primary key.
        'SELECT path FROM artifact_files WHERE artifact_id = ? AND version = ? AND path >= ? AND path < ? AND substr(path, 1, ?) = ? '
        + 'AND length(path) - ? <= ? AND instr(substr(path, ? + 1), \'/\') = 0',
      ).bind(a.id, version, dir, `${key}0`, dirLength, dir, dirLength, MARKDOWN_INDEX_MAX_LENGTH, dirLength).all<{ path: string }>();
      const found = pickMarkdownIndex(results.map(({ path }) => path), dir);
      if (found) {
        // Built from the stored path, so `guide//` cannot yield a doubled slash that shifts `../` links.
        const location = '/' + found.split('/').map(encodeURIComponent).join('/');
        return new Response(null, { status: 302, headers: { location: location + url.search, 'cache-control': 'no-store' } });
      }
    }
    const wantsHtml = (req.headers.get('accept') ?? '').includes('text/html') || !/\.[a-z0-9]+$/i.test(path);
    if (a.spa_fallback && wantsHtml) {
      if (path !== a.entry && isMarkdownPath(a.entry)) {
        // A Markdown document has a real directory for relative links and images.
        const entry = '/' + a.entry.split('/').map(encodeURIComponent).join('/');
        return new Response(null, { status: 302, headers: { location: entry + url.search, 'cache-control': 'no-store' } });
      }
      obj = await load(a.entry, true);
      servedPath = a.entry;
    } else {
      obj = await load('404.html', false);
      servedPath = '404.html';
      status = 404;
    }
    if (!obj) return plain(404, 'Not found', a, ancestors);
  }

  const headers = baseHeaders(a, isPublic, ancestors);
  obj.writeHttpMetadata(headers);
  // Older .markdown uploads used the fallback MIME type in R2.
  if (isMarkdownPath(servedPath)) {
    headers.set('content-type', plainMarkdown ? 'text/plain; charset=utf-8' : contentTypeFor(servedPath));
    headers.append('vary', 'sec-fetch-dest, accept');
  }
  headers.set('etag', obj.httpEtag);
  headers.set('last-modified', obj.uploaded.toUTCString());
  headers.set('accept-ranges', 'bytes');

  if (status === 200) {
    const precondition = preconditionStatus(req, obj);
    if (precondition) {
      if ('body' in obj) await obj.body.cancel();
      return new Response(null, { status: precondition, headers });
    }
  }
  if (isHead) {
    headers.set('content-length', String(obj.size));
    return new Response(null, { status, headers });
  }
  if (status === 200 && rangeApplied && obj.range) {
    status = 206;
    headers.set('content-range', rangeHeader(obj.range, obj.size));
  }

  if (status === 200 && isHtmlPath(servedPath)) countView(servedPath, obj.size);
  const res = new Response((obj as R2ObjectBody).body, { status, headers });
  // Only small files go to the edge cache: clone() tees the body, and for a big file sent to a slow client the
  // runtime would buffer the difference in memory (128 MB isolate).
  if (cacheable && status === 200 && servedPath === path && obj.size <= EDGE_CACHE_MAX_BYTES) {
    const cached = res.clone();
    const cacheHeaders = new Headers(cached.headers);
    cacheHeaders.set('cache-control', 'public, max-age=60');
    ctx.waitUntil(caches.default.put(cacheKey, new Response(cached.body, { headers: cacheHeaders })));
  }
  return res;
}
