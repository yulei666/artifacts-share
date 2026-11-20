import type { Env } from '../env';
import type { PageCtx } from './pages';

export const MARKDOWN_RAW_PARAM = '__share_raw';
export const MARKDOWN_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREFIX = '/__share/markdown/';

/** Only the bundled viewer assets can use this reserved namespace. */
export async function markdownAsset(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.slice(PREFIX.length);
  if (!/^(?:preview\.(?:js|css)|chunks\/[\w.-]+\.js)$/.test(path)) return new Response(null, { status: 404 });
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const asset = new URL(`/vendor/markdown/${path}`, url.origin);
  // Pass the browser's validators through so a reload costs a 304, not the (multi-MB) bundle again.
  const conditional = new Headers();
  for (const name of ['if-none-match', 'if-modified-since']) {
    const value = req.headers.get(name);
    if (value) conditional.set(name, value);
  }
  const response = await env.ASSETS.fetch(new Request(asset, { method: req.method, headers: conditional, redirect: 'manual' }));
  if (response.status === 304) return response;
  if (!response.ok || response.headers.get('content-type')?.startsWith('text/html')) return new Response(null, { status: 404 });
  if (path.startsWith('chunks/')) {
    // Chunk names carry a content hash (scripts/vendor.mjs), so they never change under the same URL.
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}

/** Bump when the reader response changes in a way the hashed inputs below do not capture (e.g. headers). */
const SHELL_VERSION = 1;
let shellHash: string | undefined;
function readerShellHash(): string {
  if (shellHash === undefined) {
    let h = 0x811c9dc5;
    const text = [SHELL_VERSION, PREFIX, MARKDOWN_RAW_PARAM, MARKDOWN_PREVIEW_MAX_BYTES, JSON.stringify(TEXT), markdownPage.toString()].join('\n');
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    shellHash = (h >>> 0).toString(36);
  }
  return shellHash;
}

/**
 * Validator for a reader page: the reader shell (template, labels, limits), the language and the source
 * object's ETag, so a deploy that changes the shell invalidates browser copies.
 */
export function markdownEtag(objectEtag: string, lang: PageCtx['lang']): string {
  return `W/"md-${readerShellHash()}-${lang}-${objectEtag.replace(/^W\//, '').replace(/"/g, '')}"`;
}

/** The source object ETag named by an If-None-Match reader validator of the current shell and language. */
export function markdownObjectEtag(ifNoneMatch: string | null, lang: PageCtx['lang']): string | null {
  if (!ifNoneMatch) return null;
  const prefix = `md-${readerShellHash()}-${lang}-`;
  for (const tag of ifNoneMatch.split(',')) {
    const value = tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    if (value.startsWith(prefix) && /^[\w-]+$/.test(value.slice(prefix.length))) return value.slice(prefix.length);
  }
  return null;
}

const TEXT = {
  zh: { preview: '渲染预览', source: '源文件', loading: '正在渲染 Markdown…', error: '无法渲染 Markdown，可以切换到源文件。', tooLarge: '此 Markdown 文件过大，无法预览。' },
  en: { preview: 'Preview', source: 'Source file', loading: 'Rendering Markdown…', error: 'Unable to render Markdown. You can still view the source file.', tooLarge: 'This Markdown file is too large to preview.' },
};

/** null means the file exceeds the browser rendering limit. HEAD can also omit its data. */
export function markdownPage(req: Request, ctx: PageCtx, headers: Headers, source: string | null, etag: string, notModified = false): Response {
  const labels = TEXT[ctx.lang];
  headers.set('etag', etag);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('referrer-policy', 'no-referrer');
  headers.append('vary', 'sec-fetch-dest, accept');
  headers.set('content-security-policy',
    `default-src 'none'; script-src ${new URL(req.url).origin}${PREFIX}; style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${ctx.ancestors}`,
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
    <article id="reader:preview" class="markdown" hidden></article>
    <pre id="reader:source" class="source" hidden></pre>
    <script type="application/json" id="reader:markdown">${JSON.stringify(source).replace(/</g, '\\u003c')}</script>`;
  const html = `<!doctype html>
<html lang="${ctx.lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Markdown</title>
  <link rel="stylesheet" href="${PREFIX}preview.css">
  ${source === null ? '' : `<script type="module" src="${PREFIX}preview.js"></script>`}
</head>
<body>
  <main class="document">${markup}</main>
</body>
</html>`;
  return new Response(html, { headers });
}
