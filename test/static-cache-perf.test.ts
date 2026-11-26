import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const MAIN = 'https://share.example.com';
const ORIGIN = { origin: MAIN };
const EXPECTED_STATIC_CC = 'public, max-age=300, stale-while-revalidate=86400';

function fetchRaw(url: string, init: RequestInit = {}): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(url, { redirect: 'manual', ...init }));
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

function makeCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

let token = '';

beforeAll(async () => {
  let res = await fetchRaw(`${MAIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }),
  });
  await json(res, 200);
  const boot = cookieFrom(res, 'as_session');

  res = await fetchRaw(`${MAIN}/api/settings/password`, {
    method: 'PUT',
    headers: { cookie: boot, 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ new_password: 'correct horse battery' }),
  });
  await json(res, 200);

  res = await fetchRaw(`${MAIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
  });
  await json(res, 200);
  const session = cookieFrom(res, 'as_session');

  const t = await json(
    await fetchRaw(`${MAIN}/api/v1/tokens`, {
      method: 'POST',
      headers: { cookie: session, origin: MAIN, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'static-cache-test' }),
    }),
    201,
  );
  token = t.token;
});

describe('main-origin static asset short caching', () => {
  it.each(['/i18n-core.js', '/i18n.js', '/viewer.js', '/ui.js', '/app.css', '/icon.svg'])(
    'sets short cache-control on 200 static asset %s (GET and HEAD)',
    async (path) => {
      const getRes = await fetchRaw(`${MAIN}${path}`);
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get('cache-control')).toBe(EXPECTED_STATIC_CC);
      expect(getRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(getRes.headers.get('x-frame-options')).toBe('DENY');

      const headRes = await fetchRaw(`${MAIN}${path}`, { method: 'HEAD' });
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('cache-control')).toBe(EXPECTED_STATIC_CC);
    },
  );

  it('does not add max-age=300 to HTML responses (/, /viewer, SPA fallback, or missing .js falling back to HTML)', async () => {
    for (const path of ['/', '/viewer', '/some/spa/route', '/missing-script.js']) {
      const res = await fetchRaw(`${MAIN}${path}`);
      const cc = res.headers.get('cache-control') ?? '';
      expect(cc, `${path} should not get static max-age=300`).not.toContain('max-age=300');
      expect(cc, `${path} should not get stale-while-revalidate`).not.toContain('stale-while-revalidate');
    }

    const viewerHtml = await (await fetchRaw(`${MAIN}/viewer`)).text();
    expect(viewerHtml).toContain('<link rel="modulepreload" href="/i18n-core.js">');
    expect(viewerHtml).not.toContain('<link rel="modulepreload" href="/i18n.js">');
  });

  it('leaves non-200 static asset responses (304, 404) and text/html responses untouched', async () => {
    const cases: Array<{ path: string; status: number; headers: Record<string, string>; body: string | null }> = [
      { path: '/i18n-core.js', status: 304, headers: { etag: '"abc"' }, body: null },
      { path: '/nope.css', status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' },
      { path: '/fake.svg', status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html>' },
    ];

    for (const tc of cases) {
      const mockAssets = {
        fetch: async () => new Response(tc.body, { status: tc.status, headers: tc.headers }),
      } as unknown as Fetcher;

      const res = await worker.fetch(
        new Request(`${MAIN}${tc.path}`),
        { ...(env as unknown as Env), ASSETS: mockAssets },
        makeCtx(),
      );
      expect(res.status).toBe(tc.status);
      expect(res.headers.get('cache-control')).toBeNull();
    }
  });

  it('keeps /s/:pid viewer responses private, no-store and preloads /i18n-core.js', async () => {
    const created = await json(
      await fetchRaw(`${MAIN}/api/v1/artifacts?title=Cache%20Check&visibility=public`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/html' },
        body: '<h1>Hello</h1>',
      }),
      201,
    );

    const okRes = await fetchRaw(`${MAIN}/s/${created.public_id}`);
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('cache-control')).toBe('private, no-store');
    const html = await okRes.text();
    expect(html).toContain('<link rel="modulepreload" href="/ui.js">');
    expect(html).toContain('<link rel="modulepreload" href="/i18n-core.js">');
    expect(html).not.toContain('<link rel="modulepreload" href="/i18n.js">');

    const missRes = await fetchRaw(`${MAIN}/s/00000000-0000-4000-8000-000000000000`);
    expect(missRes.status).toBe(404);
    expect(missRes.headers.get('cache-control')).toBe('private, no-store');
  });
});
