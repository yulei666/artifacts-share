import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { r2Key } from '../src/lib/store';
import {
  MARKDOWN_PREVIEW_MAX_BYTES,
  markdownEtag,
  readerShellHash,
  resolveMarkdownAssets,
} from '../src/content/markdown';
import MarkdownIt from 'markdown-it';
// @ts-expect-error Browser ES module bundled by esbuild (no .d.ts)
import { highlightBlocks } from '../src/content/markdown-highlight.js';
// @ts-expect-error Browser ES module bundled by esbuild (no .d.ts)
import { mathPlugin } from '../src/content/markdown-math-plugin.js';
// @ts-expect-error Browser ES module bundled by esbuild (no .d.ts)
import { renderMath } from '../src/content/markdown-math.js';
// @ts-expect-error Browser ES module bundled by esbuild (no .d.ts)
import { MAX_RENDERED_DIAGRAMS, renderDiagrams } from '../src/content/markdown-diagram.js';

const MAIN = 'https://share.example.com';
const ORIGIN = { origin: MAIN };
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const content = (id: string) => `https://${id}-share.example-content.com`;

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waits.push(Promise.resolve(p));
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: async () => {
      while (waits.length) {
        const batch = waits.splice(0);
        await Promise.allSettled(batch);
      }
    },
  };
}

async function callWorker(testEnv: Env, url: string, init: RequestInit = {}) {
  const { ctx, flush } = makeCtx();
  const req = new Request(url, { redirect: 'manual', ...init }) as Request<unknown, IncomingRequestCfProperties<unknown>>;
  const res = await worker.fetch(req, testEnv, ctx);
  return { res, flush };
}

function cookieFrom(res: Response, name: string): string {
  const all = res.headers.getSetCookie();
  const c = all.find((s) => s.startsWith(`__Host-${name}=`));
  if (!c) throw new Error(`cookie ${name} not set; got ${JSON.stringify(all)}`);
  return c.split(';')[0];
}

async function json<T = any>(res: Response, status?: number): Promise<T> {
  const text = await res.text();
  if (status !== undefined && res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

/** Wraps an R2Bucket to record `get` and `head` keys. */
function spyBucket(base: R2Bucket): { bucket: R2Bucket; gets: string[]; heads: string[] } {
  const gets: string[] = [];
  const heads: string[] = [];
  const bucket = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (key: string, options?: R2GetOptions) => {
          gets.push(key);
          return target.get(key, options);
        };
      }
      if (prop === 'head') {
        return (key: string) => {
          heads.push(key);
          return target.head(key);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { bucket, gets, heads };
}

let session = '';
let token = '';

async function api(path: string, init: RequestInit & { auth?: 'session' | 'token' | 'none'; testEnv?: Env } = {}) {
  const headers = new Headers(init.headers);
  const auth = init.auth ?? 'token';
  if (auth === 'token') headers.set('authorization', `Bearer ${token}`);
  if (auth === 'session') {
    headers.set('cookie', session);
    headers.set('origin', MAIN);
  }
  const { res, flush } = await callWorker(init.testEnv ?? (env as unknown as Env), `${MAIN}${path}`, { ...init, headers });
  await flush();
  return res;
}

async function getViewCount(artifactId: string): Promise<number> {
  const row = await (env as unknown as Env).DB.prepare('SELECT view_count FROM artifacts WHERE id = ?').bind(artifactId).first<{ view_count: number }>();
  return row?.view_count ?? 0;
}

beforeAll(async () => {
  const baseEnv = env as unknown as Env;
  let { res, flush } = await callWorker(baseEnv, `${MAIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }),
  });
  await flush();
  if (res.status === 200) {
    const body = await json<any>(res, 200);
    if (body.needs_password_setup) {
      const boot = cookieFrom(res, 'as_session');
      ({ res, flush } = await callWorker(baseEnv, `${MAIN}/api/settings/password`, {
        method: 'PUT',
        headers: { cookie: boot, 'content-type': 'application/json', ...ORIGIN },
        body: JSON.stringify({ new_password: 'correct horse battery' }),
      }));
      await flush();
      await json(res, 200);
    }
  }
  ({ res, flush } = await callWorker(baseEnv, `${MAIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
  }));
  await flush();
  await json(res, 200);
  session = cookieFrom(res, 'as_session');

  const t = await json(
    await api('/api/v1/tokens', {
      method: 'POST',
      auth: 'session',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'md-cache-perf' }),
    }),
    201,
  );
  token = t.token;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Public Markdown reader Edge Cache (Plan 2.1)', () => {
  const sampleMd = '# Hello Markdown\n\n```js\nconst answer = 42;\n```\n';
  const sampleBytes = new TextEncoder().encode(sampleMd).byteLength;

  it('caches public Markdown reader HTML with Vary stripped internally, counts views on 200 hits, and returns 304 without counting', async () => {
    const a = await json(
      await api('/api/v1/artifacts?visibility=public&filename=README.md', {
        method: 'POST',
        headers: { 'content-type': 'text/markdown' },
        body: sampleMd,
      }),
      201,
    );

    const baseEnv = env as unknown as Env;
    const assets = await resolveMarkdownAssets(baseEnv);
    const putSpy = vi.spyOn(caches.default, 'put');
    const { bucket, gets, heads } = spyBucket(baseEnv.BUCKET);
    const testEnv: Env = { ...baseEnv, BUCKET: bucket };

    const docHeaders = { 'sec-fetch-dest': 'document', 'accept-language': 'en', 'user-agent': BROWSER_UA };

    // 1. Cold miss -> reads R2 once, renders HTML, counts 1 view, populates caches.default.
    const r1 = await callWorker(testEnv, a.content_url, { headers: docHeaders });
    expect(r1.res.status).toBe(200);
    expect(r1.res.headers.get('content-type')).toContain('text/html');
    expect(r1.res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(r1.res.headers.get('vary')).toBe('sec-fetch-dest, accept');
    expect(r1.res.headers.get('x-as-source-bytes')).toBeNull();
    const etag = r1.res.headers.get('etag');
    expect(etag).toMatch(/^W\/"md-/);
    const html1 = await r1.res.text();
    expect(html1).toContain(`/__share/markdown/${assets.js}`);
    expect(html1).toContain(`/__share/markdown/${assets.css}`);
    await r1.flush();

    expect(gets).toHaveLength(1);
    expect(heads).toHaveLength(0);
    expect(await getViewCount(a.id)).toBe(1);

    // Inspect the internal cached copy stored in caches.default.
    expect(putSpy).toHaveBeenCalledTimes(1);
    const [cacheKey, cachedCopy] = putSpy.mock.calls[0] as [Request, Response];
    expect(cacheKey.url).toContain(`/__cache/md-reader/v${a.current_version}/i0/en/${readerShellHash(assets)}/README.md`);
    expect(cachedCopy.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(cachedCopy.headers.get('vary')).toBeNull();
    expect(cachedCopy.headers.get('x-as-source-bytes')).toBe(String(sampleBytes));

    // 2. Warm 200 cache hit -> 0 R2 calls, restores browser headers, strips internal header, counts view.
    const r2 = await callWorker(testEnv, a.content_url, { headers: docHeaders });
    expect(r2.res.status).toBe(200);
    expect(r2.res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(r2.res.headers.get('vary')).toBe('sec-fetch-dest, accept');
    expect(r2.res.headers.get('x-as-source-bytes')).toBeNull();
    expect(r2.res.headers.get('etag')).toBe(etag);
    expect(await r2.res.text()).toBe(html1);
    await r2.flush();

    expect(gets).toHaveLength(1);
    expect(heads).toHaveLength(0);
    expect(await getViewCount(a.id)).toBe(2);

    // 3. Warm 304 cache hit via If-None-Match -> 0 R2 calls, 304 status, does NOT count view.
    const r3 = await callWorker(testEnv, a.content_url, {
      headers: { ...docHeaders, 'if-none-match': etag! },
    });
    expect(r3.res.status).toBe(304);
    expect(r3.res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(r3.res.headers.get('vary')).toBe('sec-fetch-dest, accept');
    expect(r3.res.headers.get('x-as-source-bytes')).toBeNull();
    expect(r3.res.headers.get('content-security-policy')).toContain("default-src 'none'");
    await r3.res.arrayBuffer();
    await r3.flush();

    expect(gets).toHaveLength(1);
    expect(heads).toHaveLength(0);
    expect(await getViewCount(a.id)).toBe(2);
  });

  it('isolates cache keys by language, raw mode, indexable flag, and version, and skips cache for HEAD/private/owner/oversized', async () => {
    const a = await json(
      await api('/api/v1/artifacts?visibility=public&filename=doc.md', {
        method: 'POST',
        headers: { 'content-type': 'text/markdown' },
        body: '# V1\n',
      }),
      201,
    );

    const baseEnv = env as unknown as Env;
    const { bucket, gets, heads } = spyBucket(baseEnv.BUCKET);
    const testEnv: Env = { ...baseEnv, BUCKET: bucket };

    // Populate en cache.
    const en1 = await callWorker(testEnv, a.content_url, {
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'en', 'user-agent': BROWSER_UA },
    });
    const enEtag = en1.res.headers.get('etag')!;
    const enHtml = await en1.res.text();
    expect(enHtml).toContain('Preview');
    await en1.flush();
    expect(gets).toHaveLength(1);

    // Switch language to zh -> must miss en cache and serve zh labels (even with en ETag).
    const zh = await callWorker(testEnv, a.content_url, {
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'zh-CN', 'if-none-match': enEtag, 'user-agent': BROWSER_UA },
    });
    expect(zh.res.status).toBe(200);
    expect(await zh.res.text()).toContain('渲染预览');
    await zh.flush();
    expect(gets).toHaveLength(2);

    // Raw markdown (?__share_raw=1 and plain) uses a separate namespace and never returns reader HTML.
    const raw = await callWorker(testEnv, `${a.content_url}?__share_raw=1`);
    expect(raw.res.headers.get('content-type')).toContain('text/markdown');
    expect(raw.res.headers.get('vary')).toContain('sec-fetch-dest');
    expect(await raw.res.text()).toBe('# V1\n');
    await raw.flush();
    expect(gets).toHaveLength(3);

    const plainRaw = await callWorker(testEnv, `${a.content_url}?__share_raw=plain`);
    expect(plainRaw.res.headers.get('content-type')).toContain('text/plain');
    expect(await plainRaw.res.text()).toBe('# V1\n');
    await plainRaw.flush();
    expect(gets).toHaveLength(4);

    // Toggle indexable -> separate cache key without x-robots-tag.
    await json(
      await api(`/api/v1/artifacts/${a.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ indexable: true }),
      }),
      200,
    );
    const idxRes = await callWorker(testEnv, a.content_url, {
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'en', 'user-agent': BROWSER_UA },
    });
    expect(idxRes.res.status).toBe(200);
    expect(idxRes.res.headers.get('x-robots-tag')).toBeNull();
    await idxRes.res.arrayBuffer();
    await idxRes.flush();
    expect(gets).toHaveLength(5);

    // HEAD request skips edge cache, hits R2 head, returns empty body and does not count view.
    const viewsBeforeHead = await getViewCount(a.id);
    const headRes = await callWorker(testEnv, a.content_url, {
      method: 'HEAD',
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'en', 'user-agent': BROWSER_UA },
    });
    expect(headRes.res.status).toBe(200);
    expect(await headRes.res.text()).toBe('');
    await headRes.flush();
    expect(heads).toHaveLength(1);
    expect(await getViewCount(a.id)).toBe(viewsBeforeHead);

    // Publish version 2 -> invalidates v1 cache immediately.
    await json(
      await api(`/api/v1/artifacts/${a.id}/content`, {
        method: 'PUT',
        headers: { 'content-type': 'text/markdown' },
        body: '# V2 Updated\n',
      }),
      200,
    );
    const v2Res = await callWorker(testEnv, a.content_url, {
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'en', 'user-agent': BROWSER_UA },
    });
    expect(v2Res.res.status).toBe(200);
    expect(await v2Res.res.text()).toContain('# V2 Updated');
    await v2Res.flush();
    expect(gets).toHaveLength(6);

    // Switch to private -> immediately 404 (never serves stale edge cache).
    await json(
      await api(`/api/v1/artifacts/${a.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      }),
      200,
    );
    const privRes = await callWorker(testEnv, a.content_url, {
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'en' },
    });
    expect(privRes.res.status).toBe(404);
    await privRes.res.arrayBuffer();
    await privRes.flush();

    // Password-protected artifact never writes to caches.default.
    const pwdArt = await json(
      await api('/api/v1/artifacts?visibility=password&filename=secret.md', {
        method: 'POST',
        headers: { 'content-type': 'text/markdown' },
        body: '# Secret\n',
      }),
      201,
    );
    const unlock = await callWorker(baseEnv, `${pwdArt.content_url}?pwd=${pwdArt.password}`);
    await unlock.flush();
    const unlockCookie = cookieFrom(unlock.res, 'as_unlock');
    const putSpy = vi.spyOn(caches.default, 'put');
    const pwdRes = await callWorker(baseEnv, pwdArt.content_url, {
      headers: { 'sec-fetch-dest': 'document', cookie: unlockCookie },
    });
    expect(pwdRes.res.status).toBe(200);
    expect(await pwdRes.res.text()).toContain('# Secret');
    await pwdRes.flush();
    expect(putSpy).not.toHaveBeenCalled();

    // Oversized Markdown (> MARKDOWN_PREVIEW_MAX_BYTES) preserves "too large" shell and skips edge cache.
    const big = await json(
      await api('/api/v1/artifacts?visibility=public&filename=huge.md', {
        method: 'POST',
        headers: { 'content-type': 'text/markdown' },
        body: 'a'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1),
      }),
      201,
    );
    const bigRes = await callWorker(baseEnv, big.content_url, {
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'en' },
    });
    expect(bigRes.res.status).toBe(200);
    const bigHtml = await bigRes.res.text();
    expect(bigHtml).toContain('?__share_raw=plain');
    expect(bigHtml).not.toContain('id="reader:markdown"');
    await bigRes.flush();
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('SPA fallback Edge Cache (Plan 2.1)', () => {
  it('populates and reuses caches.default under a.entry for repeated SPA sub-route loads, with 304 and view counting', async () => {
    const form = new FormData();
    form.append('file', new File(['<!doctype html><h1>SPA Shell</h1>'], 'index.html', { type: 'text/html' }));
    form.append('file', new File(['console.log("app")'], 'assets/app.js', { type: 'text/javascript' }));
    const a = await json(
      await api('/api/v1/artifacts?visibility=public&spa_fallback=true&title=SpaCache', { method: 'POST', body: form }),
      201,
    );

    const baseEnv = env as unknown as Env;
    const putSpy = vi.spyOn(caches.default, 'put');
    const { bucket, gets } = spyBucket(baseEnv.BUCKET);
    const testEnv: Env = { ...baseEnv, BUCKET: bucket };

    const navHeaders = { accept: 'text/html', 'sec-fetch-dest': 'document', 'user-agent': BROWSER_UA };
    const entryR2Key = r2Key(a.id, a.current_version, 'index.html');

    // 1. Cold sub-route /app/page-1 -> reads index.html from R2 once and caches under a.entry's cache key.
    const r1 = await callWorker(testEnv, `${a.content_url}app/page-1`, { headers: navHeaders });
    expect(r1.res.status).toBe(200);
    expect(r1.res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    const etag = r1.res.headers.get('etag')!;
    expect(etag).toBeTruthy();
    expect(await r1.res.text()).toBe('<!doctype html><h1>SPA Shell</h1>');
    await r1.flush();

    expect(gets.filter((k) => k === entryR2Key)).toHaveLength(1);
    expect(await getViewCount(a.id)).toBe(1);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const [putKey, putRes] = putSpy.mock.calls[0] as [Request, Response];
    expect(putKey.url).toContain(`/__cache/v${a.current_version}/i0/index.html`);
    expect(putRes.headers.get('cache-control')).toBe('public, max-age=86400');

    // 2. Different sub-route /app/page-2 -> hits cached index.html without reading index.html from R2 again!
    const r2 = await callWorker(testEnv, `${a.content_url}app/page-2`, { headers: navHeaders });
    expect(r2.res.status).toBe(200);
    expect(r2.res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(await r2.res.text()).toBe('<!doctype html><h1>SPA Shell</h1>');
    await r2.flush();

    expect(gets.filter((k) => k === entryR2Key)).toHaveLength(1);
    expect(await getViewCount(a.id)).toBe(2);

    // 3. Sub-route with matching If-None-Match + If-Modified-Since (browser revalidation sends both) ->
    //    304 from edge cache, no R2 read for index.html, no view counted.
    const lastModified = r1.res.headers.get('last-modified') ?? new Date().toUTCString();
    const r3 = await callWorker(testEnv, `${a.content_url}app/page-3`, {
      headers: { ...navHeaders, 'if-none-match': etag, 'if-modified-since': lastModified },
    });
    expect(r3.res.status).toBe(304);
    expect(r3.res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    await r3.res.arrayBuffer();
    await r3.flush();

    expect(gets.filter((k) => k === entryR2Key)).toHaveLength(1);
    expect(await getViewCount(a.id)).toBe(2);

    // 4. Root / reuses the exact same cached index.html entry (0 R2 gets at all).
    const getsBeforeRoot = gets.length;
    const root = await callWorker(testEnv, a.content_url, { headers: navHeaders });
    expect(root.res.status).toBe(200);
    expect(await root.res.text()).toBe('<!doctype html><h1>SPA Shell</h1>');
    await root.flush();
    expect(gets.length).toBe(getsBeforeRoot);
    expect(await getViewCount(a.id)).toBe(3);
  });
});

describe('Hashed Markdown preview assets, CSP & lazy KaTeX/Highlights/Pele bundles', () => {
  it('resolves hashed preview assets via manifest.json, caches per env.ASSETS, falls back cleanly, and invalidates shell hash', async () => {
    const baseEnv = env as unknown as Env;
    const assets = await resolveMarkdownAssets(baseEnv);
    expect(assets.js).toMatch(/^preview-[A-Za-z0-9_-]+\.js$/);
    expect(assets.css).toMatch(/^preview-[A-Za-z0-9_-]+\.css$/);

    // Caching per env.ASSETS WeakMap: second lookup does not refetch manifest.json.
    let fetchCount = 0;
    const mockAssets = {
      fetch: async () => {
        fetchCount++;
        return new Response(JSON.stringify({ js: 'preview-AAA111.js', css: 'preview-BBB222.css' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    } as unknown as Fetcher;
    const customEnv: Env = { ...baseEnv, ASSETS: mockAssets };
    const first = await resolveMarkdownAssets(customEnv);
    const second = await resolveMarkdownAssets(customEnv);
    expect(first).toEqual({ js: 'preview-AAA111.js', css: 'preview-BBB222.css' });
    expect(second).toEqual(first);
    expect(fetchCount).toBe(1);

    // Missing manifest falls back to unhashed preview.js / preview.css.
    const missingAssets = {
      fetch: async () => new Response('not found', { status: 404 }),
    } as unknown as Fetcher;
    const fallback = await resolveMarkdownAssets({ ...baseEnv, ASSETS: missingAssets });
    expect(fallback).toEqual({ js: 'preview.js', css: 'preview.css' });

    // Transient ASSETS.fetch failures (500, throw, invalid JSON) are NOT negative-cached on the same Fetcher.
    let attempt = 0;
    const flakyAssets = {
      fetch: async () => {
        attempt++;
        if (attempt === 1) return new Response('upstream error', { status: 500 });
        if (attempt === 2) throw new Error('network blip');
        if (attempt === 3) return new Response(JSON.stringify({ js: 'bad/path.js' }), { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ js: 'preview-REC123.js', css: 'preview-REC456.css' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    } as unknown as Fetcher;
    const flakyEnv: Env = { ...baseEnv, ASSETS: flakyAssets };
    expect(await resolveMarkdownAssets(flakyEnv)).toEqual({ js: 'preview.js', css: 'preview.css' });
    expect(await resolveMarkdownAssets(flakyEnv)).toEqual({ js: 'preview.js', css: 'preview.css' });
    expect(await resolveMarkdownAssets(flakyEnv)).toEqual({ js: 'preview.js', css: 'preview.css' });
    expect(await resolveMarkdownAssets(flakyEnv)).toEqual({ js: 'preview-REC123.js', css: 'preview-REC456.css' });
    // Once valid, subsequent calls reuse the WeakMap cache without fetching again.
    expect(await resolveMarkdownAssets(flakyEnv)).toEqual({ js: 'preview-REC123.js', css: 'preview-REC456.css' });
    expect(attempt).toBe(4);

    // readerShellHash and markdownEtag change when asset filenames change.
    const hashA = readerShellHash({ js: 'preview-AAA111.js', css: 'preview-BBB222.css' });
    const hashB = readerShellHash({ js: 'preview-CCC333.js', css: 'preview-BBB222.css' });
    expect(hashA).not.toBe(hashB);
    expect(markdownEtag('"abc"', 'en', { js: 'preview-AAA111.js', css: 'preview-BBB222.css' }))
      .not.toBe(markdownEtag('"abc"', 'en', { js: 'preview-CCC333.js', css: 'preview-BBB222.css' }));
  });

  it('serves hashed preview JS/CSS, lazy math/highlight/diagram chunks, KaTeX CSS/woff2 assets, and enforces CSP + allowlist', async () => {
    const baseEnv = env as unknown as Env;
    const assets = await resolveMarkdownAssets(baseEnv);
    const a = await json(
      await api('/api/v1/artifacts?visibility=public&filename=code.md', {
        method: 'POST',
        headers: { 'content-type': 'text/markdown' },
        body: '# Code\n',
      }),
      201,
    );

    // Reader HTML CSP includes wasm-unsafe-eval for @pierre/highlights, font-src for KaTeX woff2, and style-src.
    const pageRes = await callWorker(baseEnv, a.content_url, {
      headers: { 'sec-fetch-dest': 'document', 'accept-language': 'en', 'user-agent': BROWSER_UA },
    });
    expect(pageRes.res.status).toBe(200);
    const origin = new URL(a.content_url).origin;
    const csp = pageRes.res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src ${origin}/__share/markdown/ 'wasm-unsafe-eval'`);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain(`font-src ${origin}/__share/markdown/`);
    await pageRes.res.arrayBuffer();
    await pageRes.flush();

    // Hashed JS & CSS are served with immutable caching (including on 304 revalidation).
    const jsRes = await callWorker(baseEnv, `${a.content_url}__share/markdown/${assets.js}`);
    expect(jsRes.res.status).toBe(200);
    expect(jsRes.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const jsEtag = jsRes.res.headers.get('etag')!;
    expect(jsEtag).toBeTruthy();
    const jsText = await jsRes.res.text();
    await jsRes.flush();

    const js304 = await callWorker(baseEnv, `${a.content_url}__share/markdown/${assets.js}`, {
      headers: { 'if-none-match': jsEtag },
    });
    expect(js304.res.status).toBe(304);
    expect(js304.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await js304.res.arrayBuffer();
    await js304.flush();

    const cssRes = await callWorker(baseEnv, `${a.content_url}__share/markdown/${assets.css}`);
    expect(cssRes.res.status).toBe(200);
    expect(cssRes.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const cssEtag = cssRes.res.headers.get('etag')!;
    const cssText = await cssRes.res.text();
    await cssRes.flush();

    const css304 = await callWorker(baseEnv, `${a.content_url}__share/markdown/${assets.css}`, {
      headers: { 'if-none-match': cssEtag },
    });
    expect(css304.res.status).toBe(304);
    expect(css304.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await css304.res.arrayBuffer();
    await css304.flush();

    // Legacy preview.js still works (not immutable on 200 or 304).
    const legacyJs = await callWorker(baseEnv, `${a.content_url}__share/markdown/preview.js`);
    expect(legacyJs.res.status).toBe(200);
    expect(legacyJs.res.headers.get('cache-control') ?? '').not.toContain('immutable');
    const legacyEtag = legacyJs.res.headers.get('etag')!;
    await legacyJs.res.arrayBuffer();
    await legacyJs.flush();

    const legacy304 = await callWorker(baseEnv, `${a.content_url}__share/markdown/preview.js`, {
      headers: { 'if-none-match': legacyEtag },
    });
    expect(legacy304.res.status).toBe(304);
    expect(legacy304.res.headers.get('cache-control') ?? '').not.toContain('immutable');
    await legacy304.res.arrayBuffer();
    await legacy304.flush();

    // Allowlist rejects manifest.json, disallowed extensions, and traversal paths.
    for (const badPath of ['manifest.json', 'assets/evil.js', 'assets/KaTeX_Main-Regular.ttf', 'assets/KaTeX_Main-Regular.woff', 'chunks/evil.wasm', '../fflate.js']) {
      const badRes = await callWorker(baseEnv, `${a.content_url}__share/markdown/${badPath}`);
      expect(badRes.res.status).toBe(404);
      await badRes.res.arrayBuffer();
      await badRes.flush();
    }

    // Preview entry stays lean: does NOT eagerly bundle KaTeX, @pierre/highlights WASM, or Pele.
    expect(jsText).not.toContain('katex-mathml');
    expect(jsText).not.toContain('WebAssembly.Module');
    expect(jsText).not.toContain('PeleError');
    expect(cssText).not.toContain('KaTeX_Main');

    const mathChunk = jsText.match(/import\("(?:\/__share\/markdown\/|\.?\/)(chunks\/markdown-math-[^"]+\.js)"\)/)?.[1];
    const highlightChunk = jsText.match(/import\("(?:\/__share\/markdown\/|\.?\/)(chunks\/markdown-highlight-[^"]+\.js)"\)/)?.[1];
    const diagramChunk = jsText.match(/import\("(?:\/__share\/markdown\/|\.?\/)(chunks\/markdown-diagram-[^"]+\.js)"\)/)?.[1];
    expect(mathChunk).toBeDefined();
    expect(highlightChunk).toBeDefined();
    expect(diagramChunk).toBeDefined();

    // Verify all 3 lazy chunks serve with immutable caching on 200 and 304.
    const mathChunkRes = await callWorker(baseEnv, `${a.content_url}__share/markdown/${mathChunk}`);
    expect(mathChunkRes.res.status).toBe(200);
    expect(mathChunkRes.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const mathChunkText = await mathChunkRes.res.text();
    await mathChunkRes.flush();

    const hlChunkRes = await callWorker(baseEnv, `${a.content_url}__share/markdown/${highlightChunk}`);
    expect(hlChunkRes.res.status).toBe(200);
    expect(hlChunkRes.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const hlChunkEtag = hlChunkRes.res.headers.get('etag')!;
    const hlChunkText = await hlChunkRes.res.text();
    expect(hlChunkText).toContain('code-highlighted');
    await hlChunkRes.flush();

    const hlChunk304 = await callWorker(baseEnv, `${a.content_url}__share/markdown/${highlightChunk}`, {
      headers: { 'if-none-match': hlChunkEtag },
    });
    expect(hlChunk304.res.status).toBe(304);
    expect(hlChunk304.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await hlChunk304.res.arrayBuffer();
    await hlChunk304.flush();

    const diagChunkRes = await callWorker(baseEnv, `${a.content_url}__share/markdown/${diagramChunk}`);
    expect(diagChunkRes.res.status).toBe(200);
    expect(diagChunkRes.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await diagChunkRes.res.arrayBuffer();
    await diagChunkRes.flush();

    // Lazy KaTeX CSS and referenced woff2 font are served with immutable caching on both 200 and 304.
    const katexCssPath = mathChunkText.match(/\/__share\/markdown\/(assets\/katex-[^"]+\.css)/)?.[1];
    expect(katexCssPath).toBeDefined();
    const katexCssRes = await callWorker(baseEnv, `${a.content_url}__share/markdown/${katexCssPath}`);
    expect(katexCssRes.res.status).toBe(200);
    expect(katexCssRes.res.headers.get('content-type')).toContain('text/css');
    expect(katexCssRes.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const katexCssEtag = katexCssRes.res.headers.get('etag')!;
    const katexCssText = await katexCssRes.res.text();
    expect(katexCssText).not.toContain('.ttf');
    expect(katexCssText).not.toContain('.woff"');
    await katexCssRes.flush();

    const katexCss304 = await callWorker(baseEnv, `${a.content_url}__share/markdown/${katexCssPath}`, {
      headers: { 'if-none-match': katexCssEtag },
    });
    expect(katexCss304.res.status).toBe(304);
    expect(katexCss304.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await katexCss304.res.arrayBuffer();
    await katexCss304.flush();

    const woff2Path = katexCssText.match(/\/__share\/markdown\/(assets\/KaTeX_[^")]+\.woff2)/)?.[1];
    expect(woff2Path).toBeDefined();
    const woff2Res = await callWorker(baseEnv, `${a.content_url}__share/markdown/${woff2Path}`);
    expect(woff2Res.res.status).toBe(200);
    expect(woff2Res.res.headers.get('content-type')).toContain('font/woff2');
    expect(woff2Res.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const woff2Etag = woff2Res.res.headers.get('etag')!;
    expect((await woff2Res.res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await woff2Res.flush();

    const woff2304 = await callWorker(baseEnv, `${a.content_url}__share/markdown/${woff2Path}`, {
      headers: { 'if-none-match': woff2Etag },
    });
    expect(woff2304.res.status).toBe(304);
    expect(woff2304.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await woff2304.res.arrayBuffer();
    await woff2304.flush();
  });

  it('mathPlugin tokenizes block/inline math safely and renderMath renders KaTeX with trust:false', async () => {
    const md = new MarkdownIt({ html: false }).use(mathPlugin);

    // Block & inline math.
    const singleBlock = md.render('$$E = mc^2$$\n');
    expect(singleBlock).toContain('<div class="math-block" data-math="E = mc^2">E = mc^2</div>');

    const multiBlock = md.render('$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n');
    expect(multiBlock).toContain('<div class="math-block" data-math="\\int_0^1 x^2\\,dx = \\frac{1}{3}">');

    const inline = md.render('Pythagoras: $a^2 + b^2 = c^2$ holds.\n');
    expect(inline).toContain('<span class="math-inline" data-math="a^2 + b^2 = c^2">a^2 + b^2 = c^2</span>');

    // Currency, whitespace-delimited, escaped, inline code, and fenced code are NOT parsed as math.
    const excluded = md.render([
      'Prices: $5, $10 and $20, $5-$10, $ 5 + 3 $, \\$escaped\\$.',
      'Inline code: `$x^2$` and fenced:',
      '```',
      '$$E = mc^2$$',
      '```',
    ].join('\n'));
    expect(excluded).not.toContain('math-inline');
    expect(excluded).not.toContain('math-block');

    // HTML escaping protects raw placeholder attributes and text.
    const xss = md.render('$$<script>alert("x")</script> & a < b$$\n\nInline $x < y & "z"$.\n');
    expect(xss).not.toContain('<script>');
    expect(xss).toContain('&lt;script&gt;');
    expect(xss).toContain('&amp;');

    // Repeated unclosed `$$` lines stay linear-time (non-quadratic) and unclosed `$$` before a fence does not swallow the fence.
    const t0 = performance.now();
    const manyUnclosed = md.render('$$ x\n'.repeat(15_000));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(manyUnclosed).not.toContain('math-block');

    const unclosedBeforeFence = md.render('$$\nnot closed\n\n```text\n$$\n```\n');
    expect(unclosedBeforeFence).not.toContain('math-block');
    expect(unclosedBeforeFence).toContain('<pre><code class="language-text">');

    // Minimal DOM mock to run renderMath + KaTeX in workerd.
    type MockNode = {
      nodeType: number;
      tagName?: string;
      textContent: string;
      className: string;
      children: MockNode[];
      attrs: Record<string, string>;
      style: Record<string, string> & { setProperty(k: string, v: string): void };
      isConnected: boolean;
      classList: { contains(c: string): boolean; add(c: string): void };
      getAttribute(k: string): string | null;
      setAttribute(k: string, v: string): void;
      appendChild(child: MockNode): MockNode;
      append(...nodes: MockNode[]): void;
      toText(): string;
      hasTag(tag: string): boolean;
    };
    const makeNode = (tagName?: string, text = ''): MockNode => {
      const classes = new Set<string>();
      const attrs: Record<string, string> = {};
      const children: MockNode[] = [];
      const styleObj = {
        setProperty(k: string, v: string) {
          (styleObj as unknown as Record<string, string>)[k] = v;
        },
      } as MockNode['style'];
      const node: MockNode = {
        nodeType: tagName ? 1 : 3,
        tagName,
        textContent: text,
        get className() {
          return [...classes].join(' ');
        },
        set className(v: string) {
          classes.clear();
          for (const part of String(v).split(/\s+/).filter(Boolean)) classes.add(part);
        },
        children,
        attrs,
        style: styleObj,
        isConnected: true,
        classList: {
          contains: (c: string) => classes.has(c),
          add: (c: string) => { classes.add(c); },
        },
        getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
        setAttribute: (k: string, v: string) => {
          attrs[k] = String(v);
          if (k === 'class') node.className = String(v);
        },
        appendChild: (child: MockNode) => {
          children.push(child);
          return child;
        },
        append: (...nodes: MockNode[]) => {
          children.push(...nodes);
        },
        toText: () => (node.nodeType === 3 ? node.textContent : children.map((c) => c.toText()).join('')),
        hasTag: (tag: string) => node.tagName?.toLowerCase() === tag.toLowerCase() || children.some((c) => c.hasTag(tag)),
      };
      return node;
    };

    const prevDocument = (globalThis as Record<string, unknown>).document;
    const mockDocument = {
      compatMode: 'CSS1Compat',
      head: null,
      createElement: (tag: string) => makeNode(tag),
      createElementNS: (_ns: string, tag: string) => makeNode(tag),
      createTextNode: (text: string) => makeNode(undefined, text),
      createDocumentFragment: () => makeNode('#fragment'),
    };
    (globalThis as Record<string, unknown>).document = mockDocument;
    try {
      const inlineEl = makeNode('span', 'E = mc^2');
      inlineEl.className = 'math-inline';
      inlineEl.setAttribute('data-math', 'E = mc^2');

      const untrustedEl = makeNode('div', '\\href{javascript:alert(1)}{click}');
      untrustedEl.className = 'math-block';
      untrustedEl.setAttribute('data-math', '\\href{javascript:alert(1)}{click}');

      const deepTex = '{'.repeat(5000) + 'x' + '}'.repeat(5000);
      const deepEl = makeNode('div', deepTex);
      deepEl.className = 'math-block';
      deepEl.setAttribute('data-math', deepTex);

      const article = {
        querySelectorAll: () => [inlineEl, untrustedEl, deepEl],
      };
      await renderMath(article);

      expect(inlineEl.children.length).toBeGreaterThan(0);
      expect(inlineEl.hasTag('math')).toBe(true);
      // trust: false blocks \href from producing an <a> element.
      expect(untrustedEl.hasTag('a')).toBe(false);
      // Non-ParseError throws (e.g. deep-brace RangeError) restore raw TeX fallback instead of clearing the element.
      expect(deepEl.textContent).toBe(deepTex);
      expect(deepEl.children).toHaveLength(0);
    } finally {
      if (prevDocument === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = prevDocument;
    }
  });

  it('highlightBlocks uses @pierre/highlights with dual-theme CSS vars, preserves textContent, stays XSS-safe, and skips invalid blocks', () => {
    type DomChild =
      | { type: 'text'; textContent: string }
      | { type: 'span'; className: string; textContent: string; style: Record<string, string> & { setProperty(k: string, v: string): void } };

    const makeMockDoc = () => ({
      createDocumentFragment() {
        const children: DomChild[] = [];
        return {
          children,
          append(...items: DomChild[]) {
            children.push(...items);
          },
        };
      },
      createTextNode(text: string): DomChild {
        return { type: 'text', textContent: text };
      },
      createElement(): DomChild {
        const style = {
          setProperty(k: string, v: string) {
            (style as unknown as Record<string, string>)[k] = v;
          },
        } as Record<string, string> & { setProperty(k: string, v: string): void };
        return { type: 'span', className: '', textContent: '', style };
      },
    });

    const makeCode = (text: string, isConnected = true) => {
      const classes = new Set<string>();
      const ownerDocument = makeMockDoc();
      let rendered: DomChild[] = [];
      let innerHtmlTouched = false;
      return {
        isConnected,
        textContent: text,
        ownerDocument,
        get children() {
          return rendered;
        },
        get renderedText() {
          return rendered.map((c) => c.textContent).join('');
        },
        get innerHtmlTouched() {
          return innerHtmlTouched;
        },
        set innerHTML(_v: string) {
          innerHtmlTouched = true;
        },
        replaceChildren(fragment: { children: DomChild[] }) {
          rendered = fragment.children;
        },
        classList: {
          add: (c: string) => classes.add(c),
          has: (c: string) => classes.has(c),
        },
      };
    };

    const jsSource = 'const msg = "<script>alert(1)</script>";\r\n// comment\nreturn 42;';
    const jsCode = makeCode(jsSource);
    const mermaidCode = makeCode('flowchart LR\n  A --> B');
    const plainCode = makeCode('plain text');
    const unknownCode = makeCode('some text');
    const hugeCode = makeCode('a'.repeat(64 * 1024 + 1));
    const detachedCode = makeCode('const y = 1;', false);

    highlightBlocks([
      { code: jsCode, lang: 'js' },
      { code: mermaidCode, lang: 'mermaid' },
      { code: plainCode, lang: 'text' },
      { code: unknownCode, lang: 'definitely-not-a-lang' },
      { code: hugeCode, lang: 'js' },
      { code: detachedCode, lang: 'js' },
    ]);

    expect(jsCode.classList.has('code-highlighted')).toBe(true);
    expect(jsCode.innerHtmlTouched).toBe(false);
    expect(jsCode.renderedText).toBe(jsSource);
    const styledSpans = jsCode.children.filter((c): c is Extract<DomChild, { type: 'span' }> => c.type === 'span');
    expect(styledSpans.length).toBeGreaterThan(0);
    expect(styledSpans.every((s) => s.className === 'code-tok')).toBe(true);
    expect(styledSpans.some((s) => Boolean(s.style['--tok-light']) && Boolean(s.style['--tok-dark']))).toBe(true);

    for (const skipped of [mermaidCode, plainCode, unknownCode, hugeCode, detachedCode]) {
      expect(skipped.children).toHaveLength(0);
      expect(skipped.classList.has('code-highlighted')).toBe(false);
    }
  });

  it('renderDiagrams renders flowchart/sequence/mmd/mixed-case Mermaid SVG via pele/lazy, disables links/images, falls back on bad syntax, and enforces the 20-diagram cap', async () => {
    const makeArticle = (entries: Array<string | { source: string; lang?: string }>) => {
      const blocks = entries.map((entry) => {
        const { source, lang = 'mermaid' } = typeof entry === 'string' ? { source: entry } : entry;
        const className = `language-${lang}`;
        const classes = new Set([className]);
        const block = {
          isConnected: true,
          replacedWith: null as null | { tagName: string; className: string; innerHTML: string },
          replaceWith(node: { tagName: string; className: string; innerHTML: string }) {
            block.replacedWith = node;
            block.isConnected = false;
          },
        };
        const code = {
          isConnected: true,
          textContent: source,
          className,
          classList: {
            contains: (c: string) => classes.has(c),
            [Symbol.iterator]: () => classes.values(),
          },
          parentElement: block,
          closest: (sel: string) => (sel === '.code-block' ? block : null),
        };
        return { block, code };
      });
      const ownerDocument = {
        defaultView: {},
        createElement: (tagName: string) => ({ tagName, className: '', innerHTML: '' }),
      };
      const article = {
        clientWidth: 720,
        ownerDocument,
        querySelectorAll: () => blocks.map((b) => b.code),
      };
      return { article, blocks };
    };

    // Flowchart, sequence, mmd alias, mixed-case Mermaid, non-mermaid skip, link/image stripping, and invalid syntax fallback.
    const { article, blocks } = makeArticle([
      'flowchart LR\n  A[Start] --> B[End]\n  click A href "https://example.com" "Open"',
      'sequenceDiagram\n  Alice->>Bob: Hello',
      { source: 'flowchart TD\n  X --> Y', lang: 'mmd' },
      { source: 'flowchart TD\n  M --> N', lang: 'Mermaid' },
      { source: 'const x = 1;', lang: 'js' },
      'not a valid mermaid diagram @@@',
    ]);
    await renderDiagrams(article);

    expect(blocks[0].block.replacedWith?.tagName).toBe('figure');
    expect(blocks[0].block.replacedWith?.className).toBe('diagram');
    expect(blocks[0].block.replacedWith?.innerHTML).toContain('<svg');
    expect(blocks[0].block.replacedWith?.innerHTML).toContain('pele-flowchart');
    expect(blocks[0].block.replacedWith?.innerHTML).not.toContain('<a ');
    expect(blocks[0].block.replacedWith?.innerHTML).not.toContain('https://example.com');
    expect(blocks[0].block.replacedWith?.innerHTML).not.toContain('<image');

    expect(blocks[1].block.replacedWith?.innerHTML).toContain('<svg');
    expect(blocks[1].block.replacedWith?.innerHTML).toContain('pele-sequence');

    // `mmd` alias and mixed-case `Mermaid` also render as diagrams.
    expect(blocks[2].block.replacedWith?.innerHTML).toContain('pele-flowchart');
    expect(blocks[3].block.replacedWith?.innerHTML).toContain('pele-flowchart');

    // Non-mermaid language blocks and invalid syntax diagrams keep original code blocks intact.
    expect(blocks[4].block.replacedWith).toBeNull();
    expect(blocks[4].block.isConnected).toBe(true);
    expect(blocks[5].block.replacedWith).toBeNull();
    expect(blocks[5].block.isConnected).toBe(true);

    // 20-diagram cap leaves diagrams beyond MAX_RENDERED_DIAGRAMS untouched.
    const many = Array.from({ length: MAX_RENDERED_DIAGRAMS + 2 }, (_, i) => `flowchart LR\n  A${i} --> B${i}`);
    const capped = makeArticle(many);
    await renderDiagrams(capped.article);
    const renderedCount = capped.blocks.filter((b) => b.block.replacedWith !== null).length;
    expect(renderedCount).toBe(MAX_RENDERED_DIAGRAMS);
    expect(capped.blocks[MAX_RENDERED_DIAGRAMS].block.replacedWith).toBeNull();
    expect(capped.blocks[MAX_RENDERED_DIAGRAMS + 1].block.replacedWith).toBeNull();
  });
});
