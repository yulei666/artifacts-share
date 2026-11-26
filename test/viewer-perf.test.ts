import { env, exports } from 'cloudflare:workers';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const MAIN = 'https://share.example.com';
const ORIGIN = { origin: MAIN };
const content = (id: string) => `https://${id}-share.example-content.com`;

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

let session = '';
let token = '';

async function api(path: string, init: RequestInit & { auth?: 'session' | 'token' | 'none' } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const auth = init.auth ?? 'token';
  if (auth === 'token') headers.set('authorization', `Bearer ${token}`);
  if (auth === 'session') {
    headers.set('cookie', session);
    headers.set('origin', MAIN);
  }
  return fetchRaw(`${MAIN}${path}`, { ...init, headers });
}

async function createHtml(html: string, query = ''): Promise<any> {
  return json(await api(`/api/v1/artifacts${query}`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: html }), 201);
}

async function createFolder(files: Record<string, string>, query = ''): Promise<any> {
  const form = new FormData();
  for (const [path, body] of Object.entries(files)) {
    form.append('file', new File([body], path), path);
  }
  return json(await api(`/api/v1/artifacts${query}`, { method: 'POST', body: form }), 201);
}

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
      await Promise.allSettled(waits);
      waits.length = 0;
    },
  };
}

interface DbSpy {
  prepared: string[];
  batches: string[][];
  db: D1Database;
}

/** Wraps D1 to record single-statement executions and `batch()` calls without altering behavior. */
function spyDb(real: D1Database): DbSpy {
  const prepared: string[] = [];
  const batches: string[][] = [];
  const meta = new WeakMap<object, { sql: string; raw: D1PreparedStatement }>();

  const trackStmt = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement => {
    const origBind = stmt.bind.bind(stmt);
    const proxied = new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') {
          return (...args: unknown[]) => trackStmt(sql, origBind(...args));
        }
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
          const fn = Reflect.get(target, prop, target) as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => {
            prepared.push(sql);
            return fn.apply(target, args);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    meta.set(proxied as unknown as object, { sql, raw: stmt });
    return proxied;
  };

  const db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => trackStmt(sql, target.prepare(sql));
      }
      if (prop === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          batches.push(stmts.map((s) => meta.get(s as unknown as object)?.sql ?? '<unknown>'));
          return target.batch(stmts.map((s) => meta.get(s as unknown as object)?.raw ?? s));
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });

  return { prepared, batches, db };
}

function extractViewerInit(html: string): { raw: string; data: any } | null {
  const m = /<script type="application\/json" id="viewer-init">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  return { raw: m[1], data: JSON.parse(m[1]) };
}

beforeAll(async () => {
  let res = await fetchRaw(`${MAIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }),
  });
  expect(await json(res, 200)).toMatchObject({ needs_password_setup: true });
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
  session = cookieFrom(res, 'as_session');

  const t = await json(
    await api('/api/v1/tokens', {
      method: 'POST',
      auth: 'session',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'perf-test' }),
    }),
    201,
  );
  token = t.token;
});

afterEach(async () => {
  await api('/api/settings', {
    method: 'PATCH',
    auth: 'session',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitor_download_enabled: false }),
  });
});

describe('share viewer /s/:pid inline init and preconnect', () => {
  it('injects #viewer-init, modulepreload links, and Link preconnect without crossorigin for public artifacts', async () => {
    const a = await createHtml('<h1>Public</h1>', '?title=Public%20Demo&visibility=public');

    const res = await fetchRaw(`${MAIN}/s/${a.public_id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const link = res.headers.get('link');
    expect(link).toBe(`<${content(a.public_id)}>; rel=preconnect`);
    expect(link).not.toContain('crossorigin');

    const html = await res.text();
    expect(html).toContain('<link rel="modulepreload" href="/ui.js">');
    expect(html).toContain('<link rel="modulepreload" href="/i18n-core.js">');

    const init = extractViewerInit(html);
    expect(init).not.toBeNull();
    expect(init!.data).toMatchObject({
      public_id: a.public_id,
      title: 'Public Demo',
      visibility: 'public',
      share_url: `${MAIN}/s/${a.public_id}`,
      content_url: `${content(a.public_id)}/`,
      owner: false,
      download: null,
    });
    expect(init!.data.frame_url).toBeUndefined();
    expect(init!.data.artifact).toBeUndefined();

    // Public JSON endpoint stays intact and matches #viewer-init payload.
    const apiPayload = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`), 200);
    expect(init!.data).toEqual(apiPayload);
  });

  it('withholds password-protected title in #viewer-init until unlocked, and reveals it after unlock cookie', async () => {
    const a = await createHtml('<h1>Secret</h1>', '?title=Top%20Secret&visibility=password');

    const lockedRes = await fetchRaw(`${MAIN}/s/${a.public_id}`);
    expect(lockedRes.status).toBe(200);
    const link = lockedRes.headers.get('link');
    expect(link).toBe(`<${content(a.public_id)}>; rel=preconnect`);
    expect(link).not.toContain('crossorigin');

    const lockedInit = extractViewerInit(await lockedRes.text());
    expect(lockedInit).not.toBeNull();
    expect(lockedInit!.data).toMatchObject({
      public_id: a.public_id,
      title: null,
      visibility: 'password',
      owner: false,
    });
    expect(lockedInit!.data.artifact).toBeUndefined();
    expect(lockedInit!.data.frame_url).toBeUndefined();

    // Unlock via /unlock endpoint and verify subsequent GET /s/:pid injects the real title.
    const unlockRes = await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: a.password }),
    });
    expect(await json(unlockRes, 200)).toEqual({ title: 'Top Secret' });
    const unlockCookie = cookieFrom(unlockRes, 'as_unlock_meta');

    const unlockedRes = await fetchRaw(`${MAIN}/s/${a.public_id}`, { headers: { cookie: unlockCookie } });
    expect(unlockedRes.status).toBe(200);
    const unlockedInit = extractViewerInit(await unlockedRes.text());
    expect(unlockedInit!.data.title).toBe('Top Secret');
  });

  it('injects owner metadata and a working one-time frame_url for owners on private artifacts', async () => {
    const a = await createHtml('<h1>Private</h1>', '?title=Owner%20Only&visibility=private');

    const res = await fetchRaw(`${MAIN}/s/${a.public_id}`, { headers: { cookie: session } });
    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toBe(`<${content(a.public_id)}>; rel=preconnect`);

    const init = extractViewerInit(await res.text());
    expect(init).not.toBeNull();
    expect(init!.data).toMatchObject({
      public_id: a.public_id,
      title: 'Owner Only',
      visibility: 'private',
      owner: true,
    });
    expect(init!.data.artifact).toMatchObject({ id: a.id, public_id: a.public_id, visibility: 'private' });
    expect(init!.data.frame_url).toMatch(new RegExp(`^${content(a.public_id).replace(/\./g, '\\.')}/__share/auth\\?ticket=`));

    // The injected one-time handoff ticket actually works on the content host.
    const authRes = await fetchRaw(init!.data.frame_url);
    expect(authRes.status).toBe(302);
    expect(cookieFrom(authRes, 'as_owner')).toContain('__Host-as_owner=');
  });

  it('escapes < as \\u003c and preserves $ patterns so </script> in title cannot break HTML', async () => {
    const nastyTitle = 'Price $$50 $& </script><script>alert(1)</script>';
    const a = await createHtml('<h1>XSS</h1>', `?title=${encodeURIComponent(nastyTitle)}&visibility=public`);

    const res = await fetchRaw(`${MAIN}/s/${a.public_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // No raw closing script injection, and </head> appears exactly once (no $& expansion).
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html.match(/<\/head>/g)?.length).toBe(1);

    const init = extractViewerInit(html);
    expect(init).not.toBeNull();
    expect(init!.raw).not.toContain('<');
    expect(init!.raw).toContain('\\u003c/script>');
    expect(init!.data.title).toBe(nastyTitle);
  });

  it('skips #viewer-init, Link preconnect, and owner handoff work on HEAD and 404', async () => {
    const pub = await createHtml('<h1>Pub</h1>', '?title=Pub&visibility=public');
    const priv = await createHtml('<h1>Priv</h1>', '?title=Priv&visibility=private');

    // HEAD on public artifact
    const spyHeadPub = spyDb(env.DB);
    const ctxHeadPub = makeCtx();
    const headPub = await worker.fetch(
      new Request(`${MAIN}/s/${pub.public_id}`, { method: 'HEAD' }),
      { ...(env as unknown as Env), DB: spyHeadPub.db },
      ctxHeadPub.ctx,
    );
    await ctxHeadPub.flush();
    expect(headPub.status).toBe(200);
    expect(headPub.headers.get('link')).toBeNull();
    expect(await headPub.text()).toBe('');
    expect(spyHeadPub.prepared.some((s) => s.includes('artifact_files') || s.includes('artifact_versions'))).toBe(false);

    // HEAD as owner on private artifact: no viewerInfo, no downloadSummary, no Link
    const spyHeadOwner = spyDb(env.DB);
    const ctxHeadOwner = makeCtx();
    const headOwner = await worker.fetch(
      new Request(`${MAIN}/s/${priv.public_id}`, { method: 'HEAD', headers: { cookie: session } }),
      { ...(env as unknown as Env), DB: spyHeadOwner.db },
      ctxHeadOwner.ctx,
    );
    await ctxHeadOwner.flush();
    expect(headOwner.status).toBe(200);
    expect(headOwner.headers.get('link')).toBeNull();
    expect(await headOwner.text()).toBe('');
    expect(spyHeadOwner.prepared.some((s) => s.includes('artifact_files') || s.includes('artifact_versions'))).toBe(false);

    // 404 on private artifact as non-owner: no #viewer-init, no Link
    const spy404 = spyDb(env.DB);
    const ctx404 = makeCtx();
    const notFound = await worker.fetch(
      new Request(`${MAIN}/s/${priv.public_id}`),
      { ...(env as unknown as Env), DB: spy404.db },
      ctx404.ctx,
    );
    await ctx404.flush();
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('link')).toBeNull();
    const notFoundHtml = await notFound.text();
    expect(notFoundHtml).not.toContain('id="viewer-init"');
    expect(spy404.prepared.some((s) => s.includes('artifact_files') || s.includes('artifact_versions'))).toBe(false);

    // 404 on missing UUID
    const missing = await fetchRaw(`${MAIN}/s/00000000-0000-4000-8000-000000000000`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('link')).toBeNull();
    expect(await missing.text()).not.toContain('id="viewer-init"');
  });
});

describe('login settings query consolidation', () => {
  it('reads auth settings in a single fresh D1 query on POST /api/auth/login', async () => {
    const spy = spyDb(env.DB);
    const { ctx, flush } = makeCtx();
    const res = await worker.fetch(
      new Request(`${MAIN}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ORIGIN },
        body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
      }),
      { ...(env as unknown as Env), DB: spy.db },
      ctx,
    );
    await flush();
    expect(await json(res, 200)).toEqual({ ok: true, needs_password_setup: false });

    const settingsSelects = spy.prepared.filter((sql) => /\bFROM settings\b/i.test(sql) && /^\s*SELECT\b/i.test(sql));
    expect(settingsSelects).toHaveLength(1);
  });

  it('respects fresh password_login_enabled=false even if getSettings cache was previously warm', async () => {
    // Warm getSettings cache with password_login_enabled = true.
    expect((await json(await api('/api/settings', { auth: 'session' }), 200)).password_login_enabled).toBe(true);

    // Satisfy the DB trigger requiring an alternative SSO sign-in method, then simulate another isolate
    // disabling password login directly in D1 (without invalidating this isolate's getSettings cache).
    await env.DB.prepare(
      "INSERT INTO sso_providers (provider, enabled, client_id, client_secret_enc, bound_subject, bound_display, bound_at, updated_at) VALUES ('github', 1, 'cid', 'enc', 'sub1', 'u', 1, 1) ON CONFLICT(provider) DO UPDATE SET enabled = 1, client_id = 'cid', client_secret_enc = 'enc', bound_subject = 'sub1'",
    ).run();
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('password_login_enabled', 'false', 1) ON CONFLICT(key) DO UPDATE SET value = 'false'",
    ).run();
    try {
      const spy = spyDb(env.DB);
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(
        new Request(`${MAIN}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...ORIGIN },
          body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
        }),
        { ...(env as unknown as Env), DB: spy.db },
        ctx,
      );
      await flush();
      expect(await json(res, 403)).toMatchObject({ error: { code: 'password_login_disabled' } });
      const settingsSelects = spy.prepared.filter((sql) => /\bFROM settings\b/i.test(sql) && /^\s*SELECT\b/i.test(sql));
      expect(settingsSelects).toHaveLength(1);
    } finally {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('password_login_enabled', 'true', 1) ON CONFLICT(key) DO UPDATE SET value = 'true'",
      ).run();
      await env.DB.prepare("DELETE FROM sso_providers WHERE provider = 'github'").run();
    }
  });
});

describe('folder ZIP download D1 batching', () => {
  it('batches artifact_versions and artifact_files on GET and keeps HEAD lightweight', async () => {
    const a = await createFolder(
      {
        'index.html': '<h1>Folder</h1>',
        'assets/app.js': 'console.log(1);',
        'assets/style.css': 'body{color:red}',
      },
      '?title=Batch%20Bundle&visibility=public',
    );

    await api('/api/settings', {
      method: 'PATCH',
      auth: 'session',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitor_download_enabled: true }),
    });

    // HEAD must NOT query artifact_files or run DB.batch.
    const spyHead = spyDb(env.DB);
    const ctxHead = makeCtx();
    const headRes = await worker.fetch(
      new Request(`${MAIN}/s/${a.public_id}/download`, { method: 'HEAD' }),
      { ...(env as unknown as Env), DB: spyHead.db },
      ctxHead.ctx,
    );
    await ctxHead.flush();
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toBe('application/zip');
    expect(headRes.headers.get('content-disposition')).toContain('Batch Bundle.zip');
    expect(spyHead.batches).toHaveLength(0);
    expect(spyHead.prepared.some((s) => s.includes('artifact_files'))).toBe(false);

    // GET batches artifact_versions + artifact_files in one DB.batch call and produces a valid ZIP.
    const spyGet = spyDb(env.DB);
    const ctxGet = makeCtx();
    const getRes = await worker.fetch(
      new Request(`${MAIN}/s/${a.public_id}/download`),
      { ...(env as unknown as Env), DB: spyGet.db },
      ctxGet.ctx,
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('application/zip');
    const bytes = new Uint8Array(await getRes.arrayBuffer());
    await ctxGet.flush();

    const entries = unzipSync(bytes);
    expect(Object.keys(entries).sort()).toEqual(['assets/app.js', 'assets/style.css', 'index.html']);
    expect(strFromU8(entries['index.html'])).toBe('<h1>Folder</h1>');
    expect(strFromU8(entries['assets/app.js'])).toBe('console.log(1);');
    expect(strFromU8(entries['assets/style.css'])).toBe('body{color:red}');

    expect(spyGet.batches).toHaveLength(1);
    expect(spyGet.batches[0]).toHaveLength(2);
    expect(spyGet.batches[0][0]).toContain('FROM artifact_versions');
    expect(spyGet.batches[0][0]).toContain('created_at');
    expect(spyGet.batches[0][1]).toContain('FROM artifact_files');
    expect(spyGet.prepared.some((s) => s.includes('artifact_versions') || s.includes('artifact_files'))).toBe(false);
  });
});
