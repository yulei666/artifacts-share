import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { analyticsEnabled, classifyDevice, classifyReferer, clearAnalyticsCache, INTERNAL_REFERER, normalizeRefererHost, resolveDataset } from '../src/lib/analytics';

const MAIN = 'https://share.example.com';
const ORIGIN = { origin: MAIN };

interface RecordedPoint {
  indexes?: unknown[];
  blobs?: unknown[];
  doubles?: unknown[];
}

let pendingFlushes: Promise<unknown>[] = [];

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      const wrapped = Promise.resolve(p);
      waits.push(wrapped);
      pendingFlushes.push(wrapped);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: async () => {
      await Promise.allSettled(waits);
      waits.length = 0;
    },
  };
}

async function flushAll() {
  const copy = pendingFlushes.splice(0);
  await Promise.allSettled(copy);
}

function makeAnalyticsEnv(overrides: Partial<Env> = {}) {
  const points: RecordedPoint[] = [];
  const dataset: AnalyticsEngineDataset = {
    writeDataPoint(dp) {
      points.push(dp ?? {});
    },
  };
  const testEnv: Env = {
    ...(env as unknown as Env),
    ANALYTICS: dataset,
    CF_ACCOUNT_ID: 'acct-12345',
    CF_API_TOKEN: 'cf-secret-token-xyz',
    ANALYTICS_DATASET: '',
    ...overrides,
  };
  return { testEnv, points };
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

let session = '';
let token = '';

async function callWorker(testEnv: Env, url: string, init: RequestInit & { cf?: { country?: string } } = {}) {
  const { ctx } = makeCtx();
  const { cf, ...reqInit } = init;
  const req = new Request(url, { redirect: 'manual', ...reqInit }) as Request<unknown, IncomingRequestCfProperties<unknown>>;
  if (cf) {
    Object.defineProperty(req, 'cf', { value: cf, configurable: true });
  }
  return worker.fetch(req, testEnv, ctx);
}

async function api(path: string, init: RequestInit & { auth?: 'session' | 'token' | 'none'; env?: Env } = {}) {
  const headers = new Headers(init.headers);
  const auth = init.auth ?? 'token';
  if (auth === 'token') headers.set('authorization', `Bearer ${token}`);
  if (auth === 'session') {
    headers.set('cookie', session);
    headers.set('origin', MAIN);
  }
  if (init.env) return callWorker(init.env, `${MAIN}${path}`, { ...init, headers });
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(`${MAIN}${path}`, { redirect: 'manual', ...init, headers }));
}

async function createArtifact(body: BodyInit, contentType: string, query = '') {
  return json(await api(`/api/v1/artifacts${query}`, { method: 'POST', headers: { 'content-type': contentType }, body }), 201);
}

beforeAll(async () => {
  // Either this test file runs first (needs bootstrap) or after api.test.ts (password already set).
  const bootRes = await (exports as unknown as { default: Fetcher }).default.fetch(
    new Request(`${MAIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ORIGIN },
      body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }),
    }),
  );
  if (bootRes.status === 200) {
    const bootCookie = cookieFrom(bootRes, 'as_session');
    await json(
      await (exports as unknown as { default: Fetcher }).default.fetch(
        new Request(`${MAIN}/api/settings/password`, {
          method: 'PUT',
          headers: { cookie: bootCookie, 'content-type': 'application/json', ...ORIGIN },
          body: JSON.stringify({ new_password: 'correct horse battery' }),
        }),
      ),
      200,
    );
  } else {
    await bootRes.arrayBuffer();
  }

  const loginRes = await (exports as unknown as { default: Fetcher }).default.fetch(
    new Request(`${MAIN}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ORIGIN },
      body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
    }),
  );
  await json(loginRes, 200);
  session = cookieFrom(loginRes, 'as_session');

  const tk = await json(
    await api('/api/v1/tokens', {
      method: 'POST',
      auth: 'session',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'analytics-test' }),
    }),
    201,
  );
  token = tk.token;
});

afterEach(async () => {
  await flushAll();
  clearAnalyticsCache();
  vi.restoreAllMocks();
});

describe('analytics config & helpers', () => {
  it('gates analyticsEnabled on all three required config fields', () => {
    const { testEnv } = makeAnalyticsEnv();
    expect(analyticsEnabled(testEnv)).toBe(true);
    expect(analyticsEnabled({ ...testEnv, ANALYTICS: undefined })).toBe(false);
    expect(analyticsEnabled({ ...testEnv, CF_ACCOUNT_ID: '   ' })).toBe(false);
    expect(analyticsEnabled({ ...testEnv, CF_API_TOKEN: '' })).toBe(false);
  });

  it('validates dataset names safely', () => {
    const { testEnv } = makeAnalyticsEnv({ ANALYTICS_DATASET: 'custom_ds_01' });
    expect(resolveDataset(testEnv)).toBe('custom_ds_01');
    expect(resolveDataset({ ...testEnv, ANALYTICS_DATASET: '' })).toBe('artifacts_share_events');
    expect(() => resolveDataset({ ...testEnv, ANALYTICS_DATASET: 'bad-name; DROP' })).toThrow();
  });

  it('classifies and normalizes external, internal, and invalid referer hosts', () => {
    const { testEnv } = makeAnalyticsEnv();
    expect(classifyReferer('https://www.GitHub.com:443/user/repo?a=1', testEnv)).toBe('github.com');
    expect(classifyReferer('https://share.example.com/s/123', testEnv)).toBe(INTERNAL_REFERER);
    expect(classifyReferer('https://abc-share.example-content.com/page', testEnv)).toBe(INTERNAL_REFERER);
    expect(classifyReferer(null, testEnv)).toBe('');
    expect(normalizeRefererHost('https://www.GitHub.com:443/user/repo?a=1', testEnv)).toBe('github.com');
    expect(normalizeRefererHost('http://t.co/abc', testEnv)).toBe('t.co');
    expect(normalizeRefererHost('https://share.example.com/s/123', testEnv)).toBe('');
    expect(normalizeRefererHost('https://example-content.com/x', testEnv)).toBe('');
    expect(normalizeRefererHost('https://abc-share.example-content.com/page', testEnv)).toBe('');
    expect(normalizeRefererHost('javascript:alert(1)', testEnv)).toBe('');
    expect(normalizeRefererHost('not a url', testEnv)).toBe('');
    expect(normalizeRefererHost(null, testEnv)).toBe('');
  });

  it('classifies devices without external dependencies', () => {
    expect(classifyDevice(null)).toBe('cli');
    expect(classifyDevice('curl/8.4.0')).toBe('cli');
    expect(classifyDevice('python-requests/2.31.0')).toBe('cli');
    expect(classifyDevice('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('bot');
    expect(classifyDevice('Slackbot-LinkExpanding 1.0')).toBe('bot');
    expect(classifyDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('tablet');
    expect(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36')).toBe('desktop');
  });
});

describe('analytics write paths', () => {
  it('writes no data points and reports disabled when config is incomplete', async () => {
    const a = await createArtifact('<h1>hi</h1>', 'text/html', '?visibility=public&title=Disabled');
    const { testEnv, points } = makeAnalyticsEnv({ CF_API_TOKEN: '' });

    const me = await json(await api('/api/auth/me', { auth: 'session', env: testEnv }), 200);
    expect(me.analytics_enabled).toBe(false);
    expect(await json(await api('/api/v1/analytics', { env: testEnv }), 200)).toEqual({ enabled: false });
    expect(await json(await api(`/api/v1/artifacts/${a.id}/analytics`, { env: testEnv }), 200)).toEqual({ enabled: false });

    const res = await callWorker(testEnv, a.content_url, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' } });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await flushAll();
    expect(points).toHaveLength(0);
  });

  it('records HTML and Markdown views under internal artifact.id across link regeneration', async () => {
    const html = '<h1>Hello Analytics</h1>';
    const a = await createArtifact(html, 'text/html', '?visibility=public&title=HtmlView');
    const { testEnv, points } = makeAnalyticsEnv();

    const r1 = await callWorker(testEnv, a.content_url, {
      headers: {
        'cf-connecting-ip': '203.0.113.10',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0',
        referer: 'https://www.news.ycombinator.com/item?id=1',
        'sec-fetch-dest': 'iframe',
      },
      cf: { country: 'US' },
    });
    expect(r1.status).toBe(200);
    await r1.arrayBuffer();
    await flushAll();

    expect(points).toHaveLength(1);
    expect(points[0].indexes).toEqual([a.id]);
    expect(points[0].blobs?.[0]).toBe('view');
    expect(points[0].blobs?.[1]).toMatch(/^[0-9a-f]{16}$/);
    expect(String(points[0].blobs?.[1])).not.toContain('203.0.113.10');
    expect(points[0].blobs?.[2]).toBe('US');
    expect(points[0].blobs?.[3]).toBe('news.ycombinator.com');
    expect(points[0].blobs?.[4]).toBe('desktop');
    expect(points[0].blobs?.[5]).toBe('index.html');
    expect(points[0].blobs?.[6]).toBe('public');
    expect(points[0].doubles).toEqual([1, html.length]);

    // Edge-cache hit on a repeat public HTML view also records a view.
    const r1Cached = await callWorker(testEnv, a.content_url, {
      headers: {
        'cf-connecting-ip': '203.0.113.11',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0',
      },
    });
    expect(r1Cached.status).toBe(200);
    await r1Cached.arrayBuffer();
    await flushAll();
    expect(points).toHaveLength(2);
    expect(points[1].indexes).toEqual([a.id]);
    expect(points[1].blobs?.[0]).toBe('view');

    // Regenerate link -> public_id changes, but Analytics Engine index remains internal a.id.
    const regen = await json(await api(`/api/v1/artifacts/${a.id}/regenerate-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), 200);
    expect(regen.public_id).not.toBe(a.public_id);
    const r2 = await callWorker(testEnv, regen.content_url, {
      headers: { 'cf-connecting-ip': '203.0.113.10', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0' },
    });
    expect(r2.status).toBe(200);
    await r2.arrayBuffer();
    await flushAll();
    expect(points).toHaveLength(3);
    expect(points[2].indexes).toEqual([a.id]);
    expect(points[2].blobs?.[1]).toBe(points[0].blobs?.[1]); // same visitor in same UTC month

    // Password-protected Markdown view after unlocking.
    const md = '# Title\n\nBody\n';
    const m = await createArtifact(md, 'text/markdown', '?visibility=password&title=MdView&filename=notes.md');
    const locked = await callWorker(testEnv, m.content_url, { headers: { accept: 'text/html' } });
    expect(locked.status).toBe(401);
    await locked.arrayBuffer();
    await flushAll();
    expect(points).toHaveLength(3); // 401 unlock page does not record a view

    const unlock = await callWorker(testEnv, `${m.content_url}?pwd=${m.password}`);
    const unlockCookie = cookieFrom(unlock, 'as_unlock');
    const mdRes = await callWorker(testEnv, m.content_url, {
      headers: {
        cookie: unlockCookie,
        'sec-fetch-dest': 'document',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
      },
      cf: { country: 'JP' },
    });
    expect(mdRes.status).toBe(200);
    await mdRes.arrayBuffer();
    await flushAll();
    expect(points).toHaveLength(4);
    expect(points[3].indexes).toEqual([m.id]);
    expect(points[3].blobs?.[0]).toBe('view');
    expect(points[3].blobs?.[2]).toBe('JP');
    expect(points[3].blobs?.[4]).toBe('mobile');
    expect(points[3].blobs?.[5]).toBe('notes.md');
    expect(points[3].blobs?.[6]).toBe('password');
    expect(points[3].doubles).toEqual([1, md.length]);
  });

  it('ignores owner preview, 404, static subresources, and HEAD requests', async () => {
    const form = new FormData();
    form.append('file', new File(['<link rel="stylesheet" href="s.css"><h1>Folder</h1>'], 'index.html', { type: 'text/html' }));
    form.append('file', new File(['body{color:red}'], 's.css', { type: 'text/css' }));
    const a = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    const { testEnv, points } = makeAnalyticsEnv();

    // Owner preview
    const hop = await api(`/handoff?id=${a.id}&next=/`, { auth: 'session' });
    const ownerCookie = cookieFrom(await callWorker(testEnv, hop.headers.get('location')!), 'as_owner');
    await (await callWorker(testEnv, a.content_url, { headers: { cookie: ownerCookie, 'sec-fetch-dest': 'iframe' } })).arrayBuffer();

    // HEAD, 404, CSS subresource
    await (await callWorker(testEnv, a.content_url, { method: 'HEAD' })).arrayBuffer();
    const miss = await callWorker(testEnv, `${a.content_url}missing.html`);
    expect(miss.status).toBe(404);
    await miss.arrayBuffer();
    const css = await callWorker(testEnv, `${a.content_url}s.css`, { headers: { 'sec-fetch-dest': 'style' } });
    expect(css.status).toBe(200);
    await css.arrayBuffer();

    // 304 conditional request, 206 range request, and HTML fetch() (sec-fetch-dest: empty)
    const full = await callWorker(testEnv, a.content_url, { headers: { 'sec-fetch-dest': 'empty' } });
    expect(full.status).toBe(200);
    const etag = full.headers.get('etag')!;
    await full.arrayBuffer();
    const notMod = await callWorker(testEnv, a.content_url, { headers: { 'sec-fetch-dest': 'document', 'if-none-match': etag } });
    expect(notMod.status).toBe(304);
    await notMod.arrayBuffer();
    const partial = await callWorker(testEnv, a.content_url, { headers: { 'sec-fetch-dest': 'document', range: 'bytes=0-3' } });
    expect(partial.status).toBe(206);
    await partial.arrayBuffer();
    await flushAll();

    expect(points).toHaveLength(0);
  });

  it('classifies viewer iframes, direct landings, and internal folder navigations without double-counting', async () => {
    const form = new FormData();
    form.append('file', new File(['<a href="page2.html">p2</a>'], 'index.html', { type: 'text/html' }));
    form.append('file', new File(['<p>page 2</p>'], 'page2.html', { type: 'text/html' }));
    const folder = await json(await api('/api/v1/artifacts?visibility=public&title=MultiPage', { method: 'POST', body: form }), 201);
    const { testEnv, points } = makeAnalyticsEnv();

    // 1. Direct landing on /s/:pid (no Referer) -> referral with blob4 = ''
    const directShare = await callWorker(testEnv, `${MAIN}/s/${folder.public_id}`);
    expect(directShare.status).toBe(200);
    await directShare.arrayBuffer();
    // 2. Realistic share-page iframe request (sec-fetch-dest: iframe + Referer: MAIN/) -> view with blob4 = '(internal)'
    const iframeWithRef = await callWorker(testEnv, folder.content_url, {
      headers: { referer: `${MAIN}/`, 'sec-fetch-dest': 'iframe' },
    });
    expect(iframeWithRef.status).toBe(200);
    await iframeWithRef.arrayBuffer();
    // 3. Privacy-stripped share-page iframe (sec-fetch-dest: iframe, NO Referer) -> also '(internal)' so direct landing isn't double-counted
    const iframeNoRef = await callWorker(testEnv, folder.content_url, {
      headers: { 'sec-fetch-dest': 'iframe' },
    });
    expect(iframeNoRef.status).toBe(200);
    await iframeNoRef.arrayBuffer();
    // 4. Direct top-level content-host request (sec-fetch-dest: document, NO Referer) -> view with blob4 = ''
    const directTop = await callWorker(testEnv, folder.content_url, {
      headers: { 'sec-fetch-dest': 'document' },
    });
    expect(directTop.status).toBe(200);
    await directTop.arrayBuffer();
    // 5. Folder page 2 navigation (internal Referer: content_url) -> view with blob4 = '(internal)'
    const p2 = await callWorker(testEnv, `${folder.content_url}page2.html`, {
      headers: { referer: folder.content_url, 'sec-fetch-dest': 'document' },
    });
    expect(p2.status).toBe(200);
    await p2.arrayBuffer();
    await flushAll();

    expect(points).toHaveLength(5);
    expect(points[0].blobs?.[0]).toBe('referral');
    expect(points[0].blobs?.[3]).toBe('');
    expect(points[1].blobs?.[0]).toBe('view');
    expect(points[1].blobs?.[3]).toBe(INTERNAL_REFERER);
    expect(points[2].blobs?.[0]).toBe('view');
    expect(points[2].blobs?.[3]).toBe(INTERNAL_REFERER);
    expect(points[3].blobs?.[0]).toBe('view');
    expect(points[3].blobs?.[3]).toBe('');
    expect(points[4].blobs?.[0]).toBe('view');
    expect(points[4].blobs?.[3]).toBe(INTERNAL_REFERER);

    // Throwing writeDataPoint must never turn content, viewer, or download into 500
    const brokenEnv: Env = {
      ...testEnv,
      ANALYTICS: {
        writeDataPoint() {
          throw new Error('AE write failed');
        },
      },
    };
    const safeView = await callWorker(brokenEnv, folder.content_url, { headers: { 'sec-fetch-dest': 'document' } });
    expect(safeView.status).toBe(200);
    await safeView.arrayBuffer();
    const safeShare = await callWorker(brokenEnv, `${MAIN}/s/${folder.public_id}`, { headers: { referer: 'https://x.com/post' } });
    expect(safeShare.status).toBe(200);
    await safeShare.arrayBuffer();
    await flushAll();
  });

  it('records external and direct referrals on /s/:pid and skips internal, HEAD, owner, or private artifacts', async () => {
    const pub = await createArtifact('<p>pub</p>', 'text/html', '?visibility=public');
    const priv = await createArtifact('<p>priv</p>', 'text/html', '?visibility=private');
    const { testEnv, points } = makeAnalyticsEnv();

    // Visitor with external referer -> records referral with host
    const ok = await callWorker(testEnv, `${MAIN}/s/${pub.public_id}`, {
      headers: { referer: 'https://www.github.com/org/repo', 'user-agent': 'Mozilla/5.0 Chrome/120.0' },
      cf: { country: 'DE' },
    });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();

    // Direct /s/:pid landing (missing referer) -> records referral with blob4 = ''
    const direct = await callWorker(testEnv, `${MAIN}/s/${pub.public_id}`, {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    expect(direct.status).toBe(200);
    await direct.arrayBuffer();

    // Internal referer, HEAD, private unauthenticated, or owner -> no write
    await (await callWorker(testEnv, `${MAIN}/s/${pub.public_id}`, { headers: { referer: `${MAIN}/` } })).arrayBuffer();
    await (await callWorker(testEnv, `${MAIN}/s/${pub.public_id}`, { method: 'HEAD', headers: { referer: 'https://x.com/post' } })).arrayBuffer();
    await (await callWorker(testEnv, `${MAIN}/s/${pub.public_id}`, { method: 'HEAD' })).arrayBuffer();
    await (await callWorker(testEnv, `${MAIN}/s/${priv.public_id}`, { headers: { referer: 'https://x.com/post' } })).arrayBuffer();
    await (await callWorker(testEnv, `${MAIN}/s/${pub.public_id}`, { headers: { cookie: session, referer: 'https://x.com/post' } })).arrayBuffer();
    await flushAll();

    expect(points).toHaveLength(2);
    expect(points[0].indexes).toEqual([pub.id]);
    expect(points[0].blobs?.[0]).toBe('referral');
    expect(points[0].blobs?.[2]).toBe('DE');
    expect(points[0].blobs?.[3]).toBe('github.com');
    expect(points[0].blobs?.[5]).toBe('');
    expect(points[1].indexes).toEqual([pub.id]);
    expect(points[1].blobs?.[0]).toBe('referral');
    expect(points[1].blobs?.[3]).toBe('');
  });

  it('records source and zip downloads for visitors and ignores ?check=1 and owner downloads', async () => {
    const single = await createArtifact('<p>dl</p>', 'text/html', '?visibility=public&title=DlHtml');
    const form = new FormData();
    form.append('file', new File(['<p>a</p>'], 'index.html'));
    form.append('file', new File(['<p>b</p>'], 'sub.html'));
    const folder = await json(await api('/api/v1/artifacts?visibility=public&title=DlFolder', { method: 'POST', body: form }), 201);
    const { testEnv, points } = makeAnalyticsEnv();

    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitor_download_enabled: true }) }), 200);
    try {
      // ?check=1 precheck -> no write
      await (await callWorker(testEnv, `${MAIN}/s/${single.public_id}/download?check=1`)).arrayBuffer();
      // HEAD downloads -> no write
      await (await callWorker(testEnv, `${MAIN}/s/${single.public_id}/download`, { method: 'HEAD' })).arrayBuffer();
      await (await callWorker(testEnv, `${MAIN}/s/${folder.public_id}/download`, { method: 'HEAD' })).arrayBuffer();
      // Owner download -> no write
      await (await callWorker(testEnv, `${MAIN}/s/${single.public_id}/download`, { headers: { cookie: session } })).arrayBuffer();
      await flushAll();
      expect(points).toHaveLength(0);

      // Visitor single source download
      const dl1 = await callWorker(testEnv, `${MAIN}/s/${single.public_id}/download`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' } });
      expect(dl1.status).toBe(200);
      await dl1.arrayBuffer();
      await flushAll();
      expect(points).toHaveLength(1);
      expect(points[0].indexes).toEqual([single.id]);
      expect(points[0].blobs?.[0]).toBe('download');
      expect(points[0].blobs?.[5]).toBe('source');
      expect(points[0].doubles).toEqual([1, '<p>dl</p>'.length]);

      // Visitor zip download (must read streaming body before flushing waitUntil)
      const dl2 = await callWorker(testEnv, `${MAIN}/s/${folder.public_id}/download`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' } });
      expect(dl2.status).toBe(200);
      await dl2.arrayBuffer();
      await flushAll();
      expect(points).toHaveLength(2);
      expect(points[1].indexes).toEqual([folder.id]);
      expect(points[1].blobs?.[0]).toBe('download');
      expect(points[1].blobs?.[5]).toBe('zip');
    } finally {
      await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitor_download_enabled: false }) }), 200);
    }
  });
});

describe('analytics read APIs', () => {
  it('requires authentication and validates parameters', async () => {
    const a = await createArtifact('<p>x</p>', 'text/html', '?visibility=public');
    const { testEnv } = makeAnalyticsEnv();

    expect((await api('/api/v1/analytics', { auth: 'none', env: testEnv })).status).toBe(401);
    expect((await api(`/api/v1/artifacts/${a.id}/analytics`, { auth: 'none', env: testEnv })).status).toBe(401);

    const me = await json(await api('/api/auth/me', { auth: 'session', env: testEnv }), 200);
    expect(me.analytics_enabled).toBe(true);
    const meToken = await json(await api('/api/auth/me', { auth: 'token', env: testEnv }), 200);
    expect(meToken.analytics_enabled).toBe(true);

    for (const bad of ['range=12h', 'range=all', 'range=toString', 'range=constructor', 'range=valueOf', 'range=__proto__', 'tz=abc', 'tz=900', 'tz=-800', 'tz=1.5', 'bots=2', 'bots=true']) {
      expect((await api(`/api/v1/analytics?${bad}`, { env: testEnv })).status, bad).toBe(400);
      expect((await api(`/api/v1/artifacts/${a.id}/analytics?${bad}`, { env: testEnv })).status, bad).toBe(400);
    }

    expect((await api('/api/v1/artifacts/00000000-0000-0000-0000-000000000000/analytics', { env: testEnv })).status).toBe(404);
    expect((await api('/api/v1/artifacts/not-a-uuid/analytics', { env: testEnv })).status).toBe(404);
  });

  it('queries Analytics Engine SQL API, backfills series, enriches top artifacts, and caches for 60s', async () => {
    const form = new FormData();
    form.append('file', new File(['<h1>Top</h1>'], 'index.html'));
    form.append('file', new File(['# Guide'], 'docs/guide.md'));
    const folder = await json(await api('/api/v1/artifacts?visibility=public&title=TopFolder', { method: 'POST', body: form }), 201);
    await env.DB.prepare('UPDATE artifacts SET view_count = 42 WHERE id = ?').bind(folder.id).run();

    const { testEnv } = makeAnalyticsEnv({ ANALYTICS_DATASET: 'custom_events' });
    const queries: string[] = [];
    const urls: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const shift = 86400 + 480 * 60;
    const todayBucket = Math.floor((nowSec + shift) / 86400) * 86400 - shift;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer cf-secret-token-xyz');
      const sql = String(init?.body ?? '');
      queries.push(sql);
      expect(sql).toContain('FROM custom_events');
      expect(sql).toContain('FORMAT JSON');

      if (sql.includes('GROUP BY event') && !sql.includes('GROUP BY bucket_ts')) {
        return Response.json({
          data: [
            { event: 'view', total: 25, uv: 10, no_ref: 11 },
            { event: 'referral', total: 10, uv: 0, no_ref: 4 },
            { event: 'download', total: 4, uv: 3, no_ref: 0 },
          ],
        });
      }
      if (sql.includes('GROUP BY bucket_ts, event')) {
        return Response.json({
          data: [
            { bucket_ts: todayBucket, event: 'view', total: 15, uv: 7 },
            { bucket_ts: todayBucket, event: 'download', total: 2, uv: 2 },
          ],
        });
      }
      if (sql.includes('blob3 AS code')) {
        return Response.json({ data: [{ code: 'CN', views: 18 }, { code: 'US', views: 7 }] });
      }
      if (sql.includes('blob4 AS host')) {
        return Response.json({ data: [{ host: 'github.com', hits: 10 }] });
      }
      if (sql.includes('blob5 AS device')) {
        return Response.json({ data: [{ device: 'desktop', views: 20 }, { device: 'mobile', views: 5 }] });
      }
      if (sql.includes('blob6 AS path')) {
        return Response.json({ data: [{ path: 'docs/guide.md', views: 15 }, { path: 'index.html', views: 10 }] });
      }
      if (sql.includes('index1 AS id')) {
        return Response.json({
          data: [
            { id: folder.id, views: 25, visitors: 10 },
            { id: '11111111-1111-4111-8111-111111111111', views: 3, visitors: 2 },
          ],
        });
      }
      return Response.json({ data: [] });
    });

    // Per-artifact folder query (with session auth, tz=480, bots=0)
    const detailRes = await json(await api(`/api/v1/artifacts/${folder.id}/analytics?range=7d&tz=480&bots=0`, { auth: 'session', env: testEnv }), 200);
    expect(detailRes.enabled).toBe(true);
    expect(detailRes.range).toBe('7d');
    expect(detailRes.bucket).toBe('day');
    expect(detailRes.totals).toEqual({ views: 25, visitors: 10, downloads: 4, all_time_views: 42 });
    expect(detailRes.series).toHaveLength(7);
    expect(detailRes.series[6]).toEqual({ ts: todayBucket, views: 15, visitors: 7, downloads: 2 });
    expect(detailRes.series[0].views).toBe(0);
    // Exact pure-addition direct formula: no_ref views (11) + no_ref referrals (4) = 15 (external /s/:pid referrals don't subtract).
    expect(detailRes.referrers).toEqual([
      { host: 'direct', count: 15 },
      { host: 'github.com', count: 10 },
    ]);
    expect(detailRes.paths).toEqual([
      { path: 'docs/guide.md', views: 15 },
      { path: 'index.html', views: 10 },
    ]);
    expect(queries.every((q) => q.includes(`index1 = '${folder.id}'`))).toBe(true);
    expect(queries.every((q) => q.includes("blob5 NOT IN ('bot', 'cli')"))).toBe(true);
    expect(queries.every((q) => q.includes(`timestamp >= toDateTime(${detailRes.series[0].ts})`))).toBe(true);
    expect(queries.some((q) => q.includes(`toUInt32(timestamp) + ${shift}`))).toBe(true);
    expect(queries.some((q) => q.includes(`blob4 != '${INTERNAL_REFERER}'`) && q.includes('AS hits'))).toBe(true);
    expect(urls.every((u) => u === 'https://api.cloudflare.com/client/v4/accounts/acct-12345/analytics_engine/sql')).toBe(true);

    // Cached repeat call -> no new upstream fetch calls
    const beforeCount = fetchMock.mock.calls.length;
    const cachedRes = await json(await api(`/api/v1/artifacts/${folder.id}/analytics?range=7d&tz=480&bots=0`, { env: testEnv }), 200);
    expect(cachedRes).toEqual(detailRes);
    expect(fetchMock.mock.calls.length).toBe(beforeCount);

    // Site-wide query with bots=1 and range=24h -> enriches top_artifacts from D1 (purged keeps kind/visibility null)
    queries.length = 0;
    const siteRes = await json(await api('/api/v1/analytics?range=24h&tz=0&bots=1', { env: testEnv }), 200);
    expect(siteRes.bucket).toBe('hour');
    expect(siteRes.series).toHaveLength(24);
    expect(queries.every((q) => q.includes(`timestamp >= toDateTime(${siteRes.series[0].ts})`))).toBe(true);
    expect(siteRes.totals.all_time_views).toBeGreaterThanOrEqual(42);
    expect(siteRes.top_artifacts).toEqual([
      { id: folder.id, title: 'TopFolder', kind: 'folder', visibility: 'public', deleted: false, views: 25, visitors: 10 },
      { id: '11111111-1111-4111-8111-111111111111', title: '', kind: null, visibility: null, deleted: true, views: 3, visitors: 2 },
    ]);
    expect(queries.every((q) => !q.includes("blob5 NOT IN ('bot', 'cli')"))).toBe(true);

    // Negative tz=-300 bucket alignment and concurrent in-flight deduplication
    queries.length = 0;
    const beforeDedupCount = fetchMock.mock.calls.length;
    const [rA, rB] = await Promise.all([
      api(`/api/v1/artifacts/${folder.id}/analytics?range=7d&tz=-300&bots=0`, { env: testEnv }),
      api(`/api/v1/artifacts/${folder.id}/analytics?range=7d&tz=-300&bots=0`, { env: testEnv }),
    ]);
    const negTzRes = await json(rA, 200);
    expect(await json(rB, 200)).toEqual(negTzRes);
    expect(fetchMock.mock.calls.length - beforeDedupCount).toBe(6); // deduplicated into a single 6-query batch
    expect(queries.every((q) => q.includes(`timestamp >= toDateTime(${negTzRes.series[0].ts})`))).toBe(true);
    expect(queries.some((q) => q.includes(`toUInt32(timestamp) + ${86400 - 300 * 60}`))).toBe(true);

    // Changing artifact.kind or CF_ACCOUNT_ID does not reuse stale cache entry
    await json(await api(`/api/v1/artifacts/${folder.id}/content`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>single</p>' }), 200);
    const afterKindCount = fetchMock.mock.calls.length;
    const afterKindChange = await json(await api(`/api/v1/artifacts/${folder.id}/analytics?range=7d&tz=480&bots=0`, { env: testEnv }), 200);
    expect(afterKindChange.paths).toBeUndefined();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterKindCount);

    const beforeAcctCount = fetchMock.mock.calls.length;
    const otherAcctRes = await api(`/api/v1/artifacts/${folder.id}/analytics?range=7d&tz=480&bots=0`, {
      env: { ...testEnv, CF_ACCOUNT_ID: 'acct-other' },
    });
    expect(otherAcctRes.status).toBe(200);
    await otherAcctRes.arrayBuffer();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeAcctCount);
    expect(urls).toContain('https://api.cloudflare.com/client/v4/accounts/acct-other/analytics_engine/sql');
  });

  it('reports dataset_missing without caching, rejects SQL errors as 502, and does not leak token', async () => {
    const a = await createArtifact('<p>x</p>', 'text/html', '?visibility=public');
    const { testEnv } = makeAnalyticsEnv();

    // Multi-page external landing via /s/:pid (no_ref = 0 on both view and referral) => direct = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const sql = String(init?.body ?? '');
      if (sql.includes('GROUP BY event') && !sql.includes('GROUP BY bucket_ts')) {
        return Response.json({
          data: [
            { event: 'view', total: 5, uv: 1, no_ref: 0 },
            { event: 'referral', total: 1, uv: 0, no_ref: 0 },
          ],
        });
      }
      if (sql.includes('blob4 AS host')) return Response.json({ data: [{ host: 'github.com', hits: 1 }] });
      return Response.json({ data: [] });
    });
    const noInflatedDirect = await json(await api(`/api/v1/artifacts/${a.id}/analytics?range=7d`, { env: testEnv }), 200);
    expect(noInflatedDirect.referrers).toEqual([{ host: 'github.com', count: 1 }]);

    // Both direct /s/:pid landings (no_ref=2 on referral) and direct top-level content visits (no_ref=3 on view) sum cleanly even with external referrals present
    clearAnalyticsCache();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const sql = String(init?.body ?? '');
      if (sql.includes('GROUP BY event') && !sql.includes('GROUP BY bucket_ts')) {
        return Response.json({
          data: [
            { event: 'view', total: 10, uv: 6, no_ref: 3 },
            { event: 'referral', total: 6, uv: 0, no_ref: 2 },
          ],
        });
      }
      if (sql.includes('blob4 AS host')) return Response.json({ data: [{ host: 'github.com', hits: 4 }] });
      return Response.json({ data: [] });
    });
    const combinedDirect = await json(await api(`/api/v1/artifacts/${a.id}/analytics?range=7d`, { env: testEnv }), 200);
    expect(combinedDirect.referrers).toEqual([
      { host: 'direct', count: 5 },
      { host: 'github.com', count: 4 },
    ]);

    clearAnalyticsCache();
    const missingSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('Table default.artifacts_share_events does not exist', { status: 400 }),
    );
    const emptyRes = await json(await api(`/api/v1/artifacts/${a.id}/analytics?range=30d`, { env: testEnv }), 200);
    expect(emptyRes.enabled).toBe(true);
    expect(emptyRes.dataset_missing).toBe(true);
    expect(emptyRes.series).toHaveLength(30);
    expect(emptyRes.totals.views).toBe(0);
    expect(emptyRes.countries).toEqual([]);

    // dataset_missing must NOT be cached: a subsequent query hits fetch() again.
    const callsAfterMissing = missingSpy.mock.calls.length;
    await json(await api(`/api/v1/artifacts/${a.id}/analytics?range=30d`, { env: testEnv }), 200);
    expect(missingSpy.mock.calls.length).toBeGreaterThan(callsAfterMissing);

    // SQL column/syntax errors mentioning "not found" without dataset missing pattern must return 502 (not zeros).
    missingSpy.mockImplementation(async () => new Response('column blob99 not found', { status: 400 }));
    const sqlErrRes = await api(`/api/v1/artifacts/${a.id}/analytics?range=30d`, { env: testEnv });
    expect(sqlErrRes.status).toBe(502);
    expect(await sqlErrRes.text()).toContain('analytics_upstream_error');

    clearAnalyticsCache();
    const errSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Unauthorized', { status: 403 }));
    const failRes = await api('/api/v1/analytics?range=90d', { env: testEnv });
    expect(failRes.status).toBe(502);
    const bodyText = await failRes.text();
    expect(bodyText).toContain('analytics_upstream_error');
    expect(bodyText).not.toContain('cf-secret-token-xyz');

    // Upstream 5xx/403 must not be cached.
    errSpy.mockImplementation(async () => Response.json({ data: [] }));
    const recovered = await json(await api('/api/v1/analytics?range=90d', { env: testEnv }), 200);
    expect(recovered.series).toHaveLength(90);

    // Invalid dataset name returns 500 invalid_analytics_config
    const badDsRes = await api('/api/v1/analytics', { env: { ...testEnv, ANALYTICS_DATASET: 'bad-name;drop' } });
    expect(badDsRes.status).toBe(500);
    expect((await badDsRes.json<any>()).error.code).toBe('invalid_analytics_config');
  });
});
