import type { Env } from '../env';
import type { PageCtx } from './pages';

export const MARKDOWN_RAW_PARAM = '__share_raw';
export const MARKDOWN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREFIX = '/__share/markdown/';

export interface MarkdownAssets {
  js: string;
  css: string;
}

const DEFAULT_ASSETS: MarkdownAssets = { js: 'preview.js', css: 'preview.css' };
const ASSET_PATH_RE = /^(?:preview(?:-[A-Za-z0-9_-]+)?\.(?:js|css)|chunks\/[\w.-]+\.(?:js|css)|assets\/[\w.-]+\.(?:woff2|css))$/;
const HASHED_PREVIEW_RE = /^preview-[A-Za-z0-9_-]+\.(?:js|css)$/;
const MANIFEST_JS_RE = /^preview(?:-[A-Za-z0-9_-]+)?\.js$/;
const MANIFEST_CSS_RE = /^preview(?:-[A-Za-z0-9_-]+)?\.css$/;

const assetsCache = new WeakMap<Fetcher, Promise<MarkdownAssets>>();

/** Lazily resolve the hashed Markdown preview asset filenames from the static assets manifest. */
export function resolveMarkdownAssets(env: Env): Promise<MarkdownAssets> {
  if (!env.ASSETS) return Promise.resolve(DEFAULT_ASSETS);
  const existing = assetsCache.get(env.ASSETS);
  if (existing) return existing;
  const fetcher = env.ASSETS;
  let ok = false;
  let settled = false;
  let pending: Promise<MarkdownAssets> | undefined;
  pending = (async (): Promise<MarkdownAssets> => {
    try {
      const response = await fetcher.fetch(new Request('https://assets.invalid/vendor/markdown/manifest.json'));
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return DEFAULT_ASSETS;
      }
      const data = await response.json() as Partial<MarkdownAssets>;
      if (
        typeof data.js === 'string' && MANIFEST_JS_RE.test(data.js)
        && typeof data.css === 'string' && MANIFEST_CSS_RE.test(data.css)
      ) {
        ok = true;
        return { js: data.js, css: data.css };
      }
      return DEFAULT_ASSETS;
    } catch {
      return DEFAULT_ASSETS;
    } finally {
      settled = true;
      if (!ok && pending && assetsCache.get(fetcher) === pending) assetsCache.delete(fetcher);
    }
  })();
  if (!settled || ok) assetsCache.set(fetcher, pending);
  return pending;
}

/** Only the bundled viewer assets can use this reserved namespace. */
export async function markdownAsset(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.slice(PREFIX.length);
  if (!ASSET_PATH_RE.test(path)) return new Response(null, { status: 404 });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const isLegacyPreview = path === 'preview.js' || path === 'preview.css';
  const isImmutable = path.startsWith('chunks/') || path.startsWith('assets/') || HASHED_PREVIEW_RE.test(path);
  let target = path;
  if (isLegacyPreview) {
    const assets = await resolveMarkdownAssets(env);
    target = path === 'preview.js' ? assets.js : assets.css;
  }
  const asset = new URL(`/vendor/markdown/${target}`, url.origin);
  // Pass the browser's validators through so a reload costs a 304, not the (multi-MB) bundle again.
  const conditional = new Headers();
  for (const name of ['if-none-match', 'if-modified-since']) {
    const value = req.headers.get(name);
    if (value) conditional.set(name, value);
  }
  const response = await env.ASSETS.fetch(new Request(asset, { method: req.method, headers: conditional, redirect: 'manual' }));
  if (response.status === 304) {
    if (!isImmutable) return response;
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    return new Response(null, { status: 304, headers });
  }
  if (!response.ok || response.headers.get('content-type')?.startsWith('text/html')) return new Response(null, { status: 404 });
  if (isImmutable) {
    // Hashed preview entries and chunks carry a content hash (scripts/vendor.mjs), so they never change under the same URL.
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

/** Bump when the reader response changes in a way the hashed inputs below do not capture (e.g. headers). */
const SHELL_VERSION = 3;
const shellHashes = new Map<string, string>();
export function readerShellHash(assets: MarkdownAssets = DEFAULT_ASSETS): string {
  const key = `${assets.js}\0${assets.css}`;
  const existing = shellHashes.get(key);
  if (existing !== undefined) return existing;
  let h = 0x811c9dc5;
  const text = [
    SHELL_VERSION,
    PREFIX,
    MARKDOWN_RAW_PARAM,
    MARKDOWN_PREVIEW_MAX_BYTES,
    assets.js,
    assets.css,
    JSON.stringify(TEXT),
    markdownPage.toString(),
  ].join('\n');
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  const hash = (h >>> 0).toString(36);
  if (shellHashes.size >= 32) shellHashes.clear();
  shellHashes.set(key, hash);
  return hash;
}

/**
 * Validator for a reader page: the reader shell (template, assets, labels, limits), the language and the source
 * object's ETag, so a deploy that changes the shell or bundled assets invalidates browser copies.
 */
export function markdownEtag(objectEtag: string, lang: PageCtx['lang'], assets: MarkdownAssets = DEFAULT_ASSETS): string {
  return `W/"md-${readerShellHash(assets)}-${lang}-${objectEtag.replace(/^W\//, '').replace(/"/g, '')}"`;
}

/** The source object ETag named by an If-None-Match reader validator of the current shell and language. */
export function markdownObjectEtag(ifNoneMatch: string | null, lang: PageCtx['lang'], assets: MarkdownAssets = DEFAULT_ASSETS): string | null {
  if (!ifNoneMatch) return null;
  const prefix = `md-${readerShellHash(assets)}-${lang}-`;
  for (const tag of ifNoneMatch.split(',')) {
    const value = tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    if (value.startsWith(prefix) && /^[\w-]+$/.test(value.slice(prefix.length))) return value.slice(prefix.length);
  }
  return null;
}

const TEXT = {
  zh: {
    preview: '渲染预览', source: '源文件', loading: '正在渲染 Markdown…', error: '无法渲染 Markdown，可以切换到源文件。', tooLarge: '此 Markdown 文件过大，无法预览。',
    copy: '复制代码', copied: '已复制', copySelected: '已选中代码，请手动复制。', copyFailed: '复制失败，请手动选择并复制代码。',
  },
  en: {
    preview: 'Preview', source: 'Source file', loading: 'Rendering Markdown…', error: 'Unable to render Markdown. You can still view the source file.', tooLarge: 'This Markdown file is too large to preview.',
    copy: 'Copy code', copied: 'Copied', copySelected: 'Code selected. Copy it manually.', copyFailed: 'Could not copy. Select the code to copy it manually.',
  },
};

/** null means the file exceeds the browser rendering limit. HEAD can also omit its data. */
export function markdownPage(
  req: Request,
  ctx: PageCtx,
  headers: Headers,
  source: string | null,
  etag: string,
  notModified = false,
  assets: MarkdownAssets = DEFAULT_ASSETS,
): Response {
  const labels = TEXT[ctx.lang];
  headers.set('etag', etag);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('referrer-policy', 'no-referrer');
  headers.append('vary', 'sec-fetch-dest, accept');
  const origin = new URL(req.url).origin;
  headers.set('content-security-policy',
    `default-src 'none'; script-src ${origin}${PREFIX} 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
    `font-src ${origin}${PREFIX}; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ctx.ancestors}`,
  );
  if (notModified) return new Response(null, { status: 304, headers });
  if (req.method === 'HEAD') return new Response(null, { headers });
  const markup = source === null
    ? `<p>${labels.tooLarge} <a href="?${MARKDOWN_RAW_PARAM}=plain">${labels.source}</a></p>`
    : `<div class="toolbar">
      <div class="switcher">
        <button type="button" aria-pressed="true" aria-controls="reader:preview" data-view="preview">${labels.preview}</button>
        <button type="button" aria-pressed="false" aria-controls="reader:source" data-view="source">${labels.source}</button>
      </div>
    </div>
    <p role="status" data-error="${labels.error}">${labels.loading}</p>
    <article id="reader:preview" class="markdown" data-copy="${labels.copy}" data-copied="${labels.copied}"
      data-copy-selected="${labels.copySelected}" data-copy-failed="${labels.copyFailed}" hidden></article>
    <span id="reader:copy-status" class="visually-hidden" role="status"></span>
    <pre id="reader:source" class="source" hidden></pre>
    <script type="application/json" id="reader:markdown">${JSON.stringify(source).replace(/</g, '\\u003c')}</script>`;
  const html = `<!doctype html>
<html lang="${ctx.lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Markdown</title>
  <link rel="stylesheet" href="${PREFIX}${assets.css}">
  ${source === null ? '' : `<script type="module" src="${PREFIX}${assets.js}"></script>`}
</head>
<body>
  <main class="document">${markup}</main>
</body>
</html>`;
  const body = new TextEncoder().encode(html);
  headers.set('content-length', String(body.byteLength));
  return new Response(body, { headers });
}
