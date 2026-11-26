import { exports } from 'cloudflare:workers';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const MAIN = 'https://share.example.com';
const ORIGIN = { origin: MAIN };
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
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

let session = '';
let token = '';
let staleBootstrap = '';

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

/** Follows the gateway's post-unlock cookie-check hop (`?__chk=1`) and returns the final Location. */
async function afterCheck(res: Response, cookieName: string, origin: string): Promise<string> {
  const loc = res.headers.get('location')!;
  expect(new URL(loc, origin).searchParams.get('__chk')).toBe('1');
  const hop = await fetchRaw(new URL(loc, origin).toString(), { headers: { cookie: cookieFrom(res, cookieName) } });
  expect(hop.status).toBe(302);
  return hop.headers.get('location')!;
}

async function json<T = any>(res: Response, status?: number): Promise<T> {
  const text = await res.text();
  if (status !== undefined && res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

async function createHtml(html: string, query = ''): Promise<any> {
  return json(await api(`/api/v1/artifacts${query}`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: html }), 201);
}

beforeAll(async () => {
  // Bootstrap → set password → sign in with the real password.
  let res = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }) });
  expect(await json(res, 200)).toMatchObject({ needs_password_setup: true });
  const boot = cookieFrom(res, 'as_session');
  res = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }) });
  staleBootstrap = cookieFrom(res, 'as_session');

  res = await fetchRaw(`${MAIN}/api/v1/artifacts`, { headers: { cookie: boot } });
  expect(res.status).toBe(403); // bootstrap session can't do anything else

  res = await fetchRaw(`${MAIN}/api/settings/password`, {
    method: 'PUT',
    headers: { cookie: boot, 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ new_password: 'correct horse battery' }),
  });
  await json(res, 200);

  res = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }) });
  expect(res.status).toBe(401); // bootstrap password no longer valid

  res = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
  await json(res, 200);
  session = cookieFrom(res, 'as_session');

  const t = await json(await api('/api/v1/tokens', { method: 'POST', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'ci' }) }), 201);
  token = t.token;
  expect(token).toMatch(/^as_[0-9A-Za-z]{40}$/);
});

describe('routing', () => {
  it('404s unknown hosts and non-uuid subdomains', async () => {
    expect((await fetchRaw('https://evil.example-content.com/')).status).toBe(404);
    expect((await fetchRaw('https://foo-share.example-content.com/')).status).toBe(404);
    expect((await fetchRaw('https://example.com/')).status).toBe(404);
  });

  it('serves the admin SPA with strict headers on the main host', async () => {
    const res = await fetchRaw(`${MAIN}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
  });
});

describe('auth', () => {
  it('rejects cookie-authenticated writes from another origin (CSRF)', async () => {
    const res = await fetchRaw(`${MAIN}/api/v1/artifacts`, {
      method: 'POST',
      headers: { cookie: session, origin: 'https://abc-share.example-content.com', 'content-type': 'text/html' },
      body: '<h1>x</h1>',
    });
    expect(res.status).toBe(403);
    const noOrigin = await fetchRaw(`${MAIN}/api/v1/artifacts`, { method: 'POST', headers: { cookie: session, 'content-type': 'text/html' }, body: '<h1>x</h1>' });
    expect(noOrigin.status).toBe(403);
  });

  it('does not let API tokens manage tokens or settings', async () => {
    expect((await api('/api/v1/tokens')).status).toBe(403);
    expect((await api('/api/settings')).status).toBe(403);
    expect((await api('/api/settings/sso')).status).toBe(403);
  });

  it('rejects revoked tokens', async () => {
    const t = await json(await api('/api/v1/tokens', { method: 'POST', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'tmp' }) }), 201);
    const ok = await fetchRaw(`${MAIN}/api/v1/artifacts`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(ok.status).toBe(200);
    expect((await api(`/api/v1/tokens/${t.id}`, { method: 'DELETE', auth: 'session' })).status).toBe(204);
    const bad = await fetchRaw(`${MAIN}/api/v1/artifacts`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(bad.status).toBe(401);
  });

  it('refuses to disable password login without a bound SSO provider', async () => {
    const res = await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password_login_enabled: false }) });
    expect(res.status).toBe(400);
  });

  it('lists only usable login methods', async () => {
    const m = await json(await fetchRaw(`${MAIN}/api/auth/methods`), 200);
    expect(m).toEqual({ password: true, sso: [], turnstile: null }); // Turnstile not configured in tests
  });

  it('saves SSO config without echoing the secret', async () => {
    let res = await api('/api/settings/sso/github', {
      method: 'PUT',
      auth: 'session',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'gh-client', client_secret: 'gh-secret', enabled: true }),
    });
    await json(res, 200);
    const list = await json(await api('/api/settings/sso', { auth: 'session' }), 200);
    const gh = list.items.find((i: any) => i.provider === 'github');
    expect(gh).toMatchObject({ enabled: true, client_id: 'gh-client', has_secret: true, bound: null });
    expect(JSON.stringify(list)).not.toContain('gh-secret');
    expect(gh.callback_url).toBe(`${MAIN}/api/auth/oauth/github/callback`);
    // Enabled but unbound providers are not offered for login.
    expect((await json(await fetchRaw(`${MAIN}/api/auth/methods`), 200)).sso).toEqual([]);
    // OAuth start redirects to GitHub with PKCE.
    res = await fetchRaw(`${MAIN}/api/auth/oauth/github/start?purpose=bind`, { headers: { cookie: session } });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe('https://github.com');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${MAIN}/api/auth/oauth/github/callback`);
  });
});

describe('public artifacts', () => {
  it('creates a single-HTML artifact and serves it with noindex by default', async () => {
    const a = await createHtml('<h1>Hello</h1>', '?visibility=public&title=Hello');
    expect(a).toMatchObject({ kind: 'html', visibility: 'public', title: 'Hello', indexable: false, password: null });
    expect(a.content_url).toBe(`${content(a.id)}/`);

    const res = await fetchRaw(a.content_url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(await res.text()).toBe('<h1>Hello</h1>');

    const robots = await fetchRaw(`${content(a.id)}/robots.txt`);
    expect(await robots.text()).toContain('Disallow: /');

    const idx = await json(await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ indexable: true }) }), 200);
    expect(idx.indexable).toBe(true);
    const res2 = await fetchRaw(a.content_url);
    expect(res2.headers.get('x-robots-tag')).toBeNull();
    await res2.arrayBuffer();
  });

  it('supports ETag/304 and Range/206', async () => {
    const a = await createHtml('0123456789', '?visibility=public');
    const first = await fetchRaw(a.content_url);
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();
    expect(etag).toBeTruthy();
    const notModified = await fetchRaw(a.content_url, { headers: { 'if-none-match': etag } });
    expect(notModified.status).toBe(304);
    const ranged = await fetchRaw(`${a.content_url}index.html`, { headers: { range: 'bytes=2-4' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await ranged.text()).toBe('234');
  });
});

describe('folders', () => {
  async function createFolder(query = '') {
    const form = new FormData();
    form.append('file', new File(['<script src="assets/app.js"></script>'], 'dist/index.html'));
    form.append('file', new File(['console.log(1)'], 'dist/assets/app.js'));
    form.append('file', new File(['<p>docs</p>'], 'dist/docs/index.html'));
    form.append('file', new File(['x'], 'dist/.DS_Store'));
    return json(await api(`/api/v1/artifacts${query}`, { method: 'POST', body: form }), 201);
  }

  it('uploads a folder via multipart, strips the common root and resolves paths', async () => {
    const a = await createFolder('?visibility=public');
    expect(a.kind).toBe('folder');
    expect(a.entry).toBe('index.html');

    const files = await json(await api(`/api/v1/artifacts/${a.id}/files`), 200);
    expect(files.items.map((f: any) => f.path)).toEqual(['assets/app.js', 'docs/index.html', 'index.html']);

    const js = await fetchRaw(`${content(a.id)}/assets/app.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    await js.arrayBuffer();

    const dir = await fetchRaw(`${content(a.id)}/docs`);
    expect(dir.status).toBe(301);
    expect(dir.headers.get('location')).toBe('/docs/');
    const doc = await fetchRaw(`${content(a.id)}/docs/`);
    expect(await doc.text()).toBe('<p>docs</p>');

    const missing = await fetchRaw(`${content(a.id)}/nope`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();

    await json(await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spa_fallback: true }) }), 200);
    const spa = await fetchRaw(`${content(a.id)}/some/route`, { headers: { accept: 'text/html' } });
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('assets/app.js');
  });

  it('downloads files from the API as attachments, never rendered', async () => {
    const a = await createFolder();
    const res = await api(`/api/v1/artifacts/${a.id}/files/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    await res.arrayBuffer();
  });

  it('uploads through an upload session and validates expected files', async () => {
    const begin = await json(
      await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Session', visibility: 'public', files: ['index.html', 'a.css'] }) }),
      201,
    );
    let res = await api(`/api/v1/uploads/${begin.upload_id}/files/index.html`, { method: 'PUT', body: '<link rel=stylesheet href=a.css>' });
    await json(res, 200);
    res = await api(`/api/v1/uploads/${begin.upload_id}/commit`, { method: 'POST' });
    expect(res.status).toBe(400); // a.css missing
    await res.arrayBuffer();

    res = await api(`/api/v1/uploads/${begin.upload_id}/files/a.css`, { method: 'PUT', body: 'body{}' });
    await json(res, 200);
    const a = await json(await api(`/api/v1/uploads/${begin.upload_id}/commit`, { method: 'POST' }), 201);
    expect(a).toMatchObject({ id: begin.artifact_id, title: 'Session', current_version: 1 });
  });

  it('rejects unsafe paths', async () => {
    const begin = await json(await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), 201);
    for (const p of ['..%2Fescape.html', 'a/..%2F..%2Fb', '__share/x', '..%5Cescape.html', 'a%5C..%5C..%5Cb']) {
      const res = await api(`/api/v1/uploads/${begin.upload_id}/files/${p}`, { method: 'PUT', body: 'x' });
      expect(res.status, p).toBe(400);
      await res.arrayBuffer();
    }
  });

  it('creates new versions on update and can roll back', async () => {
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    const v2 = await json(await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>v2</p>' }), 200);
    expect(v2.current_version).toBe(2);
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<p>v2</p>');

    const versions = await json(await api(`/api/v1/artifacts/${a.id}/versions`), 200);
    expect(versions.items.map((v: any) => v.version)).toEqual([2, 1]);

    await json(await api(`/api/v1/artifacts/${a.id}/versions/1/activate`, { method: 'POST' }), 200);
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<p>v1</p>');
  });

  it('keeps server-side zip extraction off until enabled', async () => {
    const zip = zipSync({ 'site/index.html': strToU8('<h1>zip</h1>'), 'site/s.css': strToU8('a{}') });
    let res = await api('/api/v1/artifacts?visibility=public', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip });
    expect(res.status).toBe(415);
    await res.arrayBuffer();

    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server_unzip_enabled: true }) }), 200);
    res = await api('/api/v1/artifacts?visibility=public', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip });
    const a = await json(res, 201);
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<h1>zip</h1>');
  });
});

describe('private artifacts', () => {
  it('hides private content and lets the owner in through a one-time handoff', async () => {
    const a = await createHtml('<p>secret</p>');
    expect(a.visibility).toBe('private');

    const anon = await fetchRaw(a.content_url, { headers: { 'accept-language': 'en' } });
    expect(anon.status).toBe(404);
    const body = await anon.text();
    expect(body).not.toContain('secret');
    expect(body).toContain('Owner sign-in');

    // Not signed in → login page with a return path.
    let res = await fetchRaw(`${MAIN}/handoff?id=${a.id}&next=/`);
    expect(res.headers.get('location')).toMatch(/^\/#\/login\?next=/);

    res = await fetchRaw(`${MAIN}/handoff?id=${a.id}&next=/`, { headers: { cookie: session } });
    expect(res.status).toBe(302);
    const authUrl = res.headers.get('location')!;
    expect(authUrl.startsWith(`${content(a.id)}/__share/auth?`)).toBe(true);

    res = await fetchRaw(authUrl);
    expect(res.status).toBe(302);
    const owner = cookieFrom(res, 'as_owner');
    expect(res.headers.getSetCookie()[0]).toMatch(/Secure; HttpOnly; SameSite=None; Partitioned/);

    res = await fetchRaw(a.content_url, { headers: { cookie: owner } });
    expect(await res.text()).toBe('<p>secret</p>');
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    // Ticket is single-use.
    expect((await fetchRaw(authUrl)).status).toBe(403);

    // The owner cookie is scoped to one artifact.
    const other = await createHtml('<p>other</p>');
    expect((await fetchRaw(other.content_url, { headers: { cookie: owner } })).status).toBe(404);
  });
});

describe('password artifacts', () => {
  it('requires the access code and invalidates it on reset', async () => {
    const a = await createHtml('<p>locked</p>', '?visibility=password');
    expect(a.password).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);

    let res = await fetchRaw(a.content_url);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('请输入访问码'); // no Accept-Language → Chinese

    res = await fetchRaw(a.content_url, { headers: { 'accept-language': 'en-US,en;q=0.9' } });
    expect(res.headers.get('content-language')).toBe('en');
    expect(await res.text()).toContain('Enter access code');

    const unlock = (code: string, ip = '1.1.1.1') =>
      fetchRaw(`${content(a.id)}/__share/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
        body: new URLSearchParams({ code, next: '/' }),
      });

    res = await unlock('WRONG1');
    expect(res.status).toBe(401);
    await res.arrayBuffer();

    res = await unlock(a.password.toLowerCase()); // case-insensitive
    expect(res.status).toBe(303);
    const cookie = cookieFrom(res, 'as_unlock');
    res = await fetchRaw(a.content_url, { headers: { cookie } });
    expect(await res.text()).toBe('<p>locked</p>');

    // ?pwd= link sets the cookie and strips the code from the URL.
    res = await fetchRaw(`${a.content_url}?pwd=${a.password}&x=1`);
    expect(res.status).toBe(302);
    expect(await afterCheck(res, 'as_unlock', a.content_url)).toBe('/?x=1');

    const reset = await json(await api(`/api/v1/artifacts/${a.id}/password/reset`, { method: 'POST' }), 200);
    expect(reset.password).not.toBe(a.password);
    res = await fetchRaw(a.content_url, { headers: { cookie } });
    expect(res.status).toBe(401);
    await res.arrayBuffer();
  });

  it('rate-limits wrong codes per IP', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const unlock = (code: string) =>
      fetchRaw(`${content(a.id)}/__share/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '9.9.9.9' },
        body: new URLSearchParams({ code, next: '/' }),
      });
    for (let i = 0; i < 5; i++) await (await unlock('AAAAAA')).arrayBuffer();
    const res = await unlock(a.password);
    expect(res.status).toBe(429);
    await res.arrayBuffer();
  });
});

describe('regenerate link', () => {
  it('moves the artifact to a new subdomain and kills the old link', async () => {
    const a = await createHtml('<p>moving</p>', '?visibility=public');
    expect(a.public_id).toBe(a.id);
    expect((await fetchRaw(a.content_url)).status).toBe(200);

    const b = await json(await api(`/api/v1/artifacts/${a.id}/regenerate-link`, { method: 'POST' }), 200);
    expect(b.id).toBe(a.id); // API id is stable
    expect(b.public_id).not.toBe(a.public_id);
    expect(b.content_url).toBe(`${content(b.public_id)}/`);

    const old = await fetchRaw(a.content_url);
    expect(old.status).toBe(404);
    await old.arrayBuffer();
    expect(await (await fetchRaw(b.content_url)).text()).toBe('<p>moving</p>');

    // Admin API still works with the original id; versions and files are untouched.
    expect((await json(await api(`/api/v1/artifacts/${a.id}/files`), 200)).items).toHaveLength(1);
  });

  it('can regenerate the access code at the same time', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const unlocked = await fetchRaw(`${a.content_url}?pwd=${a.password}`);
    const cookie = cookieFrom(unlocked, 'as_unlock');

    const keep = await json(await api(`/api/v1/artifacts/${a.id}/regenerate-link`, { method: 'POST' }), 200);
    expect(keep.password).toBe(a.password);

    const both = await json(
      await api(`/api/v1/artifacts/${a.id}/regenerate-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset_password: true }) }),
      200,
    );
    expect(both.password).not.toBe(a.password);
    const res = await fetchRaw(both.content_url, { headers: { cookie } });
    expect(res.status).toBe(401); // old unlock cookie is useless on the new host
    await res.arrayBuffer();
  });

  it('routes owner handoff to the current subdomain, from either id', async () => {
    const a = await createHtml('<p>private</p>');
    const b = await json(await api(`/api/v1/artifacts/${a.id}/regenerate-link`, { method: 'POST' }), 200);
    for (const id of [a.id, b.public_id]) {
      const res = await fetchRaw(`${MAIN}/handoff?id=${id}&next=/`, { headers: { cookie: session } });
      expect(res.headers.get('location')!.startsWith(`${content(b.public_id)}/__share/auth?`)).toBe(true);
    }
  });

  it('rejects reset_password when not in access-code mode', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=public');
    const res = await api(`/api/v1/artifacts/${a.id}/regenerate-link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset_password: true }) });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
  });
});

describe('listing and deletion', () => {
  it('lists, searches and deletes artifacts', async () => {
    const a = await createHtml('<p>find me</p>', '?title=Needle%20Title');
    const found = await json(await api('/api/v1/artifacts?q=needle'), 200);
    expect(found.items.map((i: any) => i.id)).toContain(a.id);

    expect((await api(`/api/v1/artifacts/${a.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/api/v1/artifacts/${a.id}`)).status).toBe(404);
    const gone = await fetchRaw(a.content_url);
    expect(gone.status).toBe(404);
    await gone.arrayBuffer();
  });

  it('matches multiple whitespace-separated keywords with AND semantics (including Chinese)', async () => {
    const both = await createHtml('<p>1</p>', `?visibility=public&title=${encodeURIComponent('系统架构说明 · Q4 复盘')}`);
    const onlyArch = await createHtml('<p>2</p>', `?visibility=public&title=${encodeURIComponent('系统架构总览')}`);
    const special = await createHtml('<p>3</p>', `?visibility=private&title=${encodeURIComponent('100%_完成\\归档')}`);
    // Negative control: would match `%100%_%` + `%\归档%` if LIKE wildcards or backslash were not escaped.
    const wildcardTrap = await createHtml('<p>4</p>', `?visibility=private&title=${encodeURIComponent('100xy归档')}`);

    // Out-of-order Chinese terms, full-width space, and duplicate ASCII/Chinese terms all match `both` and exclude `onlyArch`.
    for (const q of ['架构 复盘', '复盘   架构', '架构\u3000复盘', 'Q4 q4 架构 架构 复盘']) {
      const res = await json(await api(`/api/v1/artifacts?q=${encodeURIComponent(q)}`), 200);
      const ids = res.items.map((i: any) => i.id);
      expect(ids).toContain(both.id);
      expect(ids).not.toContain(onlyArch.id);
    }

    // Whitespace-only query acts as no filter.
    const blank = await json(await api(`/api/v1/artifacts?q=${encodeURIComponent('  \u3000 ')}`), 200);
    expect(blank.items.map((i: any) => i.id)).toEqual(expect.arrayContaining([both.id, onlyArch.id]));

    // Mixes a title keyword with an artifact id prefix.
    const byTitleAndId = await json(await api(`/api/v1/artifacts?q=${encodeURIComponent(`架构 ${onlyArch.id.slice(0, 8)}`)}`), 200);
    expect(byTitleAndId.items.map((i: any) => i.id)).toEqual([onlyArch.id]);

    // Escapes SQL LIKE wildcards across multiple terms (negative control `100xy归档` must NOT match).
    const escaped = await json(await api(`/api/v1/artifacts?q=${encodeURIComponent('100%_ \\归档')}`), 200);
    const escapedIds = escaped.items.map((i: any) => i.id);
    expect(escapedIds).toContain(special.id);
    expect(escapedIds).not.toContain(wildcardTrap.id);
    expect(escapedIds).not.toContain(both.id);

    // Caps >8 distinct terms to bound query/scan cost (case-insensitive ASCII dedupe keeps distinct slots).
    const many = await json(await api(`/api/v1/artifacts?q=${encodeURIComponent('Q4 q4 系统 架构 说明 复盘 系 统 架 额外不匹配词')}`), 200);
    expect(many.items.map((i: any) => i.id)).toContain(both.id);

    // Works together with visibility filter and cursor pagination.
    const page1 = await json(await api(`/api/v1/artifacts?q=${encodeURIComponent('系统 架构')}&visibility=public&limit=1`), 200);
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await json(await api(`/api/v1/artifacts?q=${encodeURIComponent('系统 架构')}&visibility=public&limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`), 200);
    expect(page2.next_cursor).toBeNull();
    expect([page1.items[0].id, page2.items[0].id].sort()).toEqual([both.id, onlyArch.id].sort());
  });
});

describe('review regressions', () => {
  it('a leftover bootstrap session cannot overwrite the admin password', async () => {
    const res = await fetchRaw(`${MAIN}/api/settings/password`, {
      method: 'PUT',
      headers: { cookie: staleBootstrap, 'content-type': 'application/json', ...ORIGIN },
      body: JSON.stringify({ new_password: 'attacker-password' }),
    });
    expect([401, 403]).toContain(res.status);
    await res.arrayBuffer();
    const login = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
    expect(login.status).toBe(200);
    await login.arrayBuffer();
  });

  it('never redirects off-origin after handoff', async () => {
    const a = await createHtml('<p>x</p>');
    for (const next of ['/\t/evil.com', '/\\evil.com', '//evil.com', 'https://evil.com', '/%2F%2Fevil.com']) {
      const res = await fetchRaw(`${MAIN}/handoff?id=${a.id}&next=${encodeURIComponent(next)}`, { headers: { cookie: session } });
      const auth = await fetchRaw(res.headers.get('location')!);
      const loc = auth.headers.get('location')!;
      expect(loc, next).toMatch(/^\/(?![\/\\])/);
      expect(new URL(loc, 'https://x.example').host, next).toBe('x.example');
    }
  });

  it('keeps ?pwd= and directory redirects on the same host', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const res = await fetchRaw(`${content(a.public_id)}//evil.com?pwd=${a.password}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/evil\.com\?/);
    expect(await afterCheck(res, 'as_unlock', a.content_url)).toBe('/evil.com');
  });

  it('does not leak files from a failed upload into the next version', async () => {
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_file_bytes: 1024 }) }), 200);
    const form = new FormData();
    form.append('file', new File(['x'.repeat(2048)], 'big.html'));
    for (let i = 0; i < 12; i++) form.append('file', new File([`<p>${i}</p>`], `f${i}.html`));
    const failed = await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', body: form });
    expect(failed.status).toBe(413);
    await failed.arrayBuffer();
    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_file_bytes: 100 * 1024 * 1024 }) }), 200);

    const v = await json(await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>v2</p>' }), 200);
    const files = await json(await api(`/api/v1/artifacts/${a.id}/files?version=${v.current_version}`), 200);
    expect(files.items.map((f: any) => f.path)).toEqual(['index.html']);
  });

  it('strips the common root from an explicit entry', async () => {
    const res = await api('/api/v1/artifacts?entry=docs/page.html', { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<p>p</p>' });
    expect((await json(res, 201)).entry).toBe('page.html');
  });

  it('keeps cache entries apart for names containing # or ?', async () => {
    const form = new FormData();
    form.append('file', new File(['<p>i</p>'], 'index.html'));
    form.append('file', new File(['one'], 'a#1.txt'));
    form.append('file', new File(['two'], 'a#2.txt'));
    const a = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    expect(await (await fetchRaw(`${a.content_url}a%231.txt`)).text()).toBe('one');
    expect(await (await fetchRaw(`${a.content_url}a%232.txt`)).text()).toBe('two');
  });

  it('rejects prototype keys as settings', async () => {
    for (const k of ['constructor', 'hasOwnProperty', '__proto__']) {
      const res = await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: `{"${k}":1}` });
      expect(res.status, k).toBe(400);
      await res.arrayBuffer();
    }
  });

  it('updates kind when activating an older version', async () => {
    const a = await createHtml('<p>v1</p>');
    const form = new FormData();
    form.append('file', new File(['<p>i</p>'], 'index.html'));
    form.append('file', new File(['a{}'], 's.css'));
    expect((await json(await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', body: form }), 200)).kind).toBe('folder');
    expect((await json(await api(`/api/v1/artifacts/${a.id}/versions/1/activate`, { method: 'POST' }), 200)).kind).toBe('html');
  });
});

describe('review regressions (round 2)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const begin = async (body: object) => json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) }), 201);
  const put = async (uid: string, path: string, body: string) => json(await api(`/api/v1/uploads/${uid}/files/${path}`, { method: 'PUT', body }), 200);

  it('survives malformed cookie values', async () => {
    const a = await createHtml('<p>ok</p>', '?visibility=public');
    const res = await fetchRaw(a.content_url, { headers: { cookie: 'x=%E0%A4%A; constructor=1' } });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const me = await fetchRaw(`${MAIN}/api/auth/me`, { headers: { cookie: `bad=%; ${session}` } });
    expect(me.status).toBe(200);
    await me.arrayBuffer();
  });

  it('never rolls back to an older version committed last', async () => {
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    const older = await begin({ artifact_id: a.id });
    const newer = await begin({ artifact_id: a.id });
    expect(newer.version).toBeGreaterThan(older.version);
    await put(newer.upload_id, 'index.html', '<p>newer</p>');
    await put(older.upload_id, 'index.html', '<p>older</p>');
    await json(await api(`/api/v1/uploads/${newer.upload_id}/commit`, { method: 'POST' }), 200);
    const late = await api(`/api/v1/uploads/${older.upload_id}/commit`, { method: 'POST' });
    expect(late.status).toBe(409); // stored in history, but not live — and the caller is told so
    expect((await late.json<any>()).error).toMatchObject({ code: 'superseded', version: older.version, current_version: newer.version });
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<p>newer</p>');
  });

  it('does not reuse a version number after an abort', async () => {
    const a = await createHtml('<p>v1</p>');
    const first = await begin({ artifact_id: a.id });
    await put(first.upload_id, 'index.html', 'x');
    expect((await api(`/api/v1/uploads/${first.upload_id}`, { method: 'DELETE' })).status).toBe(204);
    const second = await begin({ artifact_id: a.id });
    expect(second.version).toBe(first.version + 1);
    // the aborted upload's files are gone and it can no longer be written to
    const late = await api(`/api/v1/uploads/${first.upload_id}/files/late.html`, { method: 'PUT', body: 'x' });
    expect(late.status).toBe(404);
    await late.arrayBuffer();
  });

  it('restores the entry a version was published with when activating it', async () => {
    const form = new FormData();
    form.append('file', new File(['<p>a</p>'], 'a.html'));
    form.append('file', new File(['<p>b</p>'], 'b.html'));
    const a = await json(await api('/api/v1/artifacts?entry=b.html&visibility=public', { method: 'POST', body: form }), 201);
    await json(await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>v2</p>' }), 200);
    const back = await json(await api(`/api/v1/artifacts/${a.id}/versions/1/activate`, { method: 'POST' }), 200);
    expect(back.entry).toBe('b.html');
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<p>b</p>');
  });

  it('caps the server-side zip size below the Worker memory limit', async () => {
    const res = await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify({ unzip_max_bytes: 100 * 1024 * 1024 }) });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
  });

  it('returns 400 for a malformed list cursor', async () => {
    for (const cursor of ['%%%', btoa('nope'), btoa('12:')]) {
      const res = await api(`/api/v1/artifacts?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status, cursor).toBe(400);
      await res.arrayBuffer();
    }
  });

  it('answers HEAD with metadata only', async () => {
    const a = await createHtml('0123456789', '?visibility=public');
    const res = await fetchRaw(a.content_url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(await res.text()).toBe('');
  });

  it('counts views served from the edge cache', async () => {
    const a = await createHtml('<p>count</p>', '?visibility=public');
    for (let i = 0; i < 3; i++) await (await fetchRaw(a.content_url, { headers: { 'sec-fetch-dest': 'document', 'user-agent': BROWSER_UA } })).arrayBuffer();
    let views = 0;
    for (let i = 0; i < 20 && views < 3; i++) {
      views = (await json(await api(`/api/v1/artifacts/${a.id}`), 200)).view_count;
      if (views < 3) await new Promise((r) => setTimeout(r, 25));
    }
    expect(views).toBe(3);
  });

  it('excludes bots, CLIs, and browser prefetches from D1 view_count', async () => {
    const a = await createHtml('<p>filtered</p>', '?visibility=public');
    const ignored: Record<string, string>[] = [
      { 'sec-fetch-dest': 'document', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
      { 'sec-fetch-dest': 'document', 'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.0' },
      { 'sec-fetch-dest': 'document', 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
      { 'sec-fetch-dest': 'document', 'user-agent': 'curl/8.7.1' },
      { 'sec-fetch-dest': 'document' }, // empty User-Agent → cli
      { 'sec-fetch-dest': 'document', 'user-agent': BROWSER_UA, 'sec-purpose': 'prefetch' },
      { 'sec-fetch-dest': 'document', 'user-agent': BROWSER_UA, 'sec-purpose': 'prefetch;prerender' },
      { 'sec-fetch-dest': 'document', 'user-agent': BROWSER_UA, purpose: 'prefetch' },
    ];
    for (const headers of ignored) await (await fetchRaw(a.content_url, { headers })).arrayBuffer();
    await (await fetchRaw(a.content_url, { headers: { 'sec-fetch-dest': 'iframe', 'user-agent': BROWSER_UA } })).arrayBuffer();
    let views = 0;
    for (let i = 0; i < 20 && views < 1; i++) {
      views = (await json(await api(`/api/v1/artifacts/${a.id}`), 200)).view_count;
      if (views < 1) await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect((await json(await api(`/api/v1/artifacts/${a.id}`), 200)).view_count).toBe(1);
  });
});

describe('share viewer (main domain)', () => {
  it('uses the main-domain viewer page as the share link', async () => {
    const a = await createHtml('<p>v</p>', '?visibility=public&title=Viewer');
    expect(a.url).toBe(`${MAIN}/s/${a.public_id}`);
    expect(a.content_url).toBe(`${content(a.public_id)}/`);

    const res = await fetchRaw(a.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain('frame-src https://*.example-content.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(await res.text()).toContain('/viewer.js');
  });

  it('hides private artifacts from anonymous visitors, not from the owner', async () => {
    const a = await createHtml('<p>p</p>');
    const anon = await fetchRaw(a.url);
    expect(anon.status).toBe(404);
    await anon.arrayBuffer();
    expect((await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`)).status).toBe(404);

    const mine = await fetchRaw(a.url, { headers: { cookie: session } });
    expect(mine.status).toBe(200);
    await mine.arrayBuffer();
    const info = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: session } }), 200);
    expect(info.owner).toBe(true);
    expect(info.artifact.id).toBe(a.id);
    expect(info.frame_url.startsWith(`${content(a.public_id)}/__share/auth?`)).toBe(true);
    // the frame URL signs the owner in on the subdomain
    const auth = await fetchRaw(info.frame_url);
    expect(auth.status).toBe(302);
    const owner = cookieFrom(auth, 'as_owner');
    expect(await (await fetchRaw(a.content_url, { headers: { cookie: owner } })).text()).toBe('<p>p</p>');
  });

  it('gives visitors only what the iframe would show them', async () => {
    const pub = await createHtml('<p>x</p>', '?visibility=public&title=Open');
    const info = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${pub.public_id}`), 200);
    expect(info).toEqual({ download: null, public_id: pub.public_id, title: 'Open', visibility: 'public', share_url: pub.url, content_url: pub.content_url, owner: false });

    const locked = await createHtml('<p>x</p>', '?visibility=password&title=Secret%20title');
    const li = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${locked.public_id}`), 200);
    expect(li.title).toBeNull();
    expect(JSON.stringify(li)).not.toContain(locked.password);

    expect((await fetchRaw(`${MAIN}/s/not-a-uuid`)).status).toBe(404);
  });

  it('lets only the main domain frame artifact content', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=public');
    const res = await fetchRaw(a.content_url);
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors 'self' ${MAIN}`);
    await res.arrayBuffer();

    const locked = await createHtml('<p>x</p>', '?visibility=password');
    const page = await fetchRaw(locked.content_url);
    expect(page.headers.get('content-security-policy')).toContain(`frame-ancestors 'self' ${MAIN}`);
    await page.arrayBuffer();
    const unlocked = await fetchRaw(`${locked.content_url}?pwd=${locked.password}`);
    expect(unlocked.headers.getSetCookie()[0]).toMatch(/SameSite=None; Partitioned/);
  });

  it('allows crawling only of viewer pages that opt in', async () => {
    expect(await (await fetchRaw(`${MAIN}/robots.txt`)).text()).toContain('Allow: /s/');
    const a = await createHtml('<p>x</p>', '?visibility=public');
    const hidden = await fetchRaw(a.url);
    expect(hidden.headers.get('x-robots-tag')).toContain('noindex');
    await hidden.arrayBuffer();
    await json(await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ indexable: true }) }), 200);
    const shown = await fetchRaw(a.url);
    expect(shown.headers.get('x-robots-tag')).toBe('all');
    await shown.arrayBuffer();
  });

  it('reveals a password artifact title after unlocking and keeps it across reloads until reset', async () => {
    const a = await createHtml('<p>secret</p>', '?visibility=password&title=Quarterly%20Plan');
    const b = await createHtml('<p>secret2</p>', '?visibility=password&title=Design%20Doc');
    const priv = await createHtml('<p>priv</p>', '?visibility=private&title=Hidden');
    const pub = await createHtml('<p>pub</p>', '?visibility=public&title=Public%20Doc');
    const ip = { 'cf-connecting-ip': '203.0.113.41' };

    // Before unlock: title is withheld, tampered cookie is ignored.
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`), 200)).title).toBeNull();
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: '__Host-as_unlock_meta=tampered.sig' } }), 200)).title).toBeNull();

    // Private artifact looks nonexistent; public returns title without setting an unlock cookie.
    expect((await fetchRaw(`${MAIN}/api/public/artifacts/${priv.public_id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', ...ip }, body: JSON.stringify({ code: 'AAAAAA' }) })).status).toBe(404);
    const pubRes = await fetchRaw(`${MAIN}/api/public/artifacts/${pub.public_id}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', ...ip }, body: JSON.stringify({}) });
    expect(await json(pubRes, 200)).toEqual({ title: 'Public Doc' });
    expect(pubRes.headers.getSetCookie()).toEqual([]);

    // Non-JSON Content-Type (e.g., cross-site text/plain form POST) is rejected before touching cookies or rate limits.
    expect((await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...ip },
      body: JSON.stringify({ code: a.password }),
    })).status).toBe(415);

    // A signed content-host unlock token cannot be confused for a main-domain unlock_meta cookie.
    const subUnlock = await fetchRaw(`${a.content_url}?pwd=${a.password}`, { headers: ip });
    const subUnlockVal = cookieFrom(subUnlock, 'as_unlock').split('=')[1];
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: `__Host-as_unlock_meta=${subUnlockVal}` } }), 200)).title).toBeNull();

    // Owner session gets CSRF-checked on cross-site Origin and gets title without setting visitor cookie on same-origin.
    expect((await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session, origin: 'https://evil.example' },
      body: JSON.stringify({}),
    })).status).toBe(403);
    const ownerRes = await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session, ...ORIGIN },
      body: JSON.stringify({}),
    });
    expect(await json(ownerRes, 200)).toEqual({ title: 'Quarterly Plan' });
    expect(ownerRes.headers.getSetCookie().some((c) => c.startsWith('__Host-as_unlock_meta='))).toBe(false);

    // Valid code (case-insensitive + trimmed) returns the title and sets an HttpOnly signed cookie.
    const okRes = await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ code: ` ${a.password!.toLowerCase()} ` }),
    });
    expect(await json(okRes, 200)).toEqual({ title: 'Quarterly Plan' });
    const rawSetCookie = okRes.headers.getSetCookie().find((c) => c.startsWith('__Host-as_unlock_meta='));
    expect(rawSetCookie).toMatch(/HttpOnly/);
    expect(rawSetCookie).toMatch(/Secure/);
    expect(rawSetCookie).toMatch(/SameSite=Lax/);
    const metaCookieA = cookieFrom(okRes, 'as_unlock_meta');

    // Subsequent GET (page reload after ?pwd= is stripped) keeps returning the real title.
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: metaCookieA } }), 200)).title).toBe('Quarterly Plan');
    // Unrelated password artifact stays hidden.
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${b.public_id}`, { headers: { cookie: metaCookieA } }), 200)).title).toBeNull();

    // Empty title ("") is returned as "" (not null) once unlocked so the viewer shows "Untitled" instead of "Protected".
    const untitled = await createHtml('<p>u</p>', '?visibility=password&title=');
    const untitledRes = await fetchRaw(`${MAIN}/api/public/artifacts/${untitled.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ code: untitled.password }),
    });
    expect(await json(untitledRes, 200)).toEqual({ title: '' });
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${untitled.public_id}`, { headers: { cookie: cookieFrom(untitledRes, 'as_unlock_meta') } }), 200)).title).toBe('');

    // Unlocking a second artifact preserves the first inside the same cookie.
    const okResB = await fetchRaw(`${MAIN}/api/public/artifacts/${b.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: metaCookieA, ...ip },
      body: JSON.stringify({ code: b.password }),
    });
    expect(await json(okResB, 200)).toEqual({ title: 'Design Doc' });
    const metaCookieAB = cookieFrom(okResB, 'as_unlock_meta');
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: metaCookieAB } }), 200)).title).toBe('Quarterly Plan');
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${b.public_id}`, { headers: { cookie: metaCookieAB } }), 200)).title).toBe('Design Doc');

    // Resetting the access code bumps password_ver and immediately invalidates the cookie entry for `a` only.
    await json(await api(`/api/v1/artifacts/${a.id}/password/reset`, { method: 'POST' }), 200);
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: metaCookieAB } }), 200)).title).toBeNull();
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${b.public_id}`, { headers: { cookie: metaCookieAB } }), 200)).title).toBe('Design Doc');

    // Admin logout clears the unlock-meta cookie alongside the session cookie.
    const logoutRes = await fetchRaw(`${MAIN}/api/auth/logout`, { method: 'POST', headers: { cookie: metaCookieAB } });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.getSetCookie().some((c) => c.startsWith('__Host-as_unlock_meta=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('shares the access-code rate limit on /unlock and never leaks title on failure', async () => {
    const a = await createHtml('<p>secret</p>', '?visibility=password&title=Top%20Secret');
    const ip = { 'cf-connecting-ip': '203.0.113.42' };

    const bad1 = await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ code: 'WRONG1' }),
    });
    const body1 = await json(bad1, 403);
    expect(body1.error.code).toBe('incorrect_code');
    expect(body1.error.remaining).toBe(4);
    expect(JSON.stringify(body1)).not.toContain('Top Secret');
    expect(bad1.headers.getSetCookie()).toEqual([]);

    // Subsequent failure on the content gateway shares the same counter (remaining drops from 4 to 3).
    const gwBad = await fetchRaw(`${a.content_url}?pwd=WRONG2&__lang=en`, { headers: ip });
    expect(gwBad.status).toBe(401);
    expect(await gwBad.text()).toContain('3 attempt(s) left');

    // Next /unlock failure sees remaining = 2, then 1, then 429 rate_limited.
    const bad3 = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ code: 'BAD003' }),
    }), 403);
    expect(bad3.error.remaining).toBe(2);
    const bad4 = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ code: 'BAD004' }),
    }), 403);
    expect(bad4.error.remaining).toBe(1);
    const locked = await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ code: 'BAD005' }),
    });
    const lockedBody = await json(locked, 429);
    expect(lockedBody.error.code).toBe('rate_limited');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('notifies the parent viewer with a signed proof after manual iframe unlock', async () => {
    const a = await createHtml('<p>manual</p>', '?visibility=password&title=Manual%20Unlock');
    const b = await createHtml('<p>other</p>', '?visibility=password&title=Other%20Secret');
    const pub = await createHtml('<p>pub</p>', '?visibility=public&title=Open%20Page');
    const ip = { 'cf-connecting-ip': '203.0.113.43' };

    // Static bridge script is served on the content host (GET + HEAD; 405 on POST; CORP: same-origin).
    const js = await fetchRaw(`${a.content_url}__share/unlocked.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(await js.text()).toContain('as:unlocked');
    const jsHead = await fetchRaw(`${a.content_url}__share/unlocked.js`, { method: 'HEAD' });
    expect(jsHead.status).toBe(200);
    expect(jsHead.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(await jsHead.text()).toBe('');
    expect((await fetchRaw(`${a.content_url}__share/unlocked.js`, { method: 'POST' })).status).toBe(405);

    // Manual form unlock on the content subdomain redirects to __chk=1.
    const form = new URLSearchParams({ code: a.password!, next: '/docs/page.html?x=1', __lang: 'en' });
    const submit = await fetchRaw(`${a.content_url}__share/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...ip },
      body: form.toString(),
    });
    expect(submit.status).toBe(303);
    const unlockCookie = cookieFrom(submit, 'as_unlock');
    const chkUrl = new URL(submit.headers.get('location')!, a.content_url).toString();

    // Non-iframe / HEAD / omitted Sec-Fetch-Dest / public / owner requests still get a plain 302 redirect.
    const nonIframe: RequestInit[] = [
      { headers: { cookie: unlockCookie, 'sec-fetch-dest': 'document' } },
      { headers: { cookie: unlockCookie } },
      { method: 'HEAD', headers: { cookie: unlockCookie, 'sec-fetch-dest': 'iframe' } },
    ];
    for (const reqInit of nonIframe) {
      const hop = await fetchRaw(chkUrl, reqInit);
      expect(hop.status).toBe(302);
      expect(hop.headers.get('location')).toBe('/docs/page.html?x=1');
    }
    const pubChk = await fetchRaw(`${pub.content_url}?__chk=1&__lang=en`, { headers: { 'sec-fetch-dest': 'iframe' } });
    expect(pubChk.status).toBe(302);
    expect(pubChk.headers.get('location')).toBe('/');
    const ownerInfo = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: session } }), 200);
    const ownerAuth = await fetchRaw(ownerInfo.frame_url);
    const ownerCookie = cookieFrom(ownerAuth, 'as_owner');
    const ownerChk = await fetchRaw(new URL(ownerAuth.headers.get('location')!, a.content_url).toString(), {
      headers: { cookie: ownerCookie, 'sec-fetch-dest': 'iframe' },
    });
    expect(ownerChk.status).toBe(302);
    expect(ownerChk.headers.get('location')).toBe('/');

    // Blocked 3P cookie in iframe still shows cookiesBlockedPage (never emits a proof).
    const blocked = await fetchRaw(chkUrl, { headers: { 'sec-fetch-dest': 'iframe' } });
    expect(blocked.status).toBe(200);
    const blockedHtml = await blocked.text();
    expect(blockedHtml).not.toContain('data-proof=');

    // Accepted cookie inside iframe returns the strict-CSP bridge page carrying a signed proof.
    const iframeHop = await fetchRaw(chkUrl, { headers: { cookie: unlockCookie, 'sec-fetch-dest': 'iframe' } });
    expect(iframeHop.status).toBe(200);
    expect(iframeHop.headers.get('cache-control')).toBe('private, no-store');
    expect(iframeHop.headers.get('referrer-policy')).toBe('no-referrer');
    expect(iframeHop.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(iframeHop.headers.get('content-security-policy')).toBe(
      `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self' ${MAIN}; base-uri 'none'`,
    );
    const html = await iframeHop.text();
    expect(html).toContain(`data-origin="${MAIN}"`);
    expect(html).toContain('data-next="/docs/page.html?x=1"');
    const proof = html.match(/data-proof="([^"]+)"/)?.[1];
    expect(proof).toBeDefined();

    // ?pwd= iframe hop also strips pwd from data-next.
    const pwdJump = await fetchRaw(`${a.content_url}?pwd=${a.password}&__lang=en`, { headers: ip });
    expect(pwdJump.status).toBe(302);
    const pwdChk = await fetchRaw(new URL(pwdJump.headers.get('location')!, a.content_url).toString(), {
      headers: { cookie: cookieFrom(pwdJump, 'as_unlock'), 'sec-fetch-dest': 'iframe' },
    });
    expect(pwdChk.status).toBe(200);
    const pwdHtml = await pwdChk.text();
    expect(pwdHtml).toContain('data-next="/"');
    expect(pwdHtml).not.toContain(a.password!);

    // Token confusion: content as_unlock token is rejected as proof, and proof is rejected as as_unlock cookie.
    const rawUnlockVal = unlockCookie.split('=')[1];
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ proof: rawUnlockVal }),
    }), 403)).error.code).toBe('invalid_proof');
    const spoofedSub = await fetchRaw(a.content_url, { headers: { cookie: `__Host-as_unlock=${proof}` } });
    expect(spoofedSub.status).toBe(401);
    await spoofedSub.arrayBuffer();

    // Proof for artifact `a` cannot be used on artifact `b`, and tampered proof is rejected.
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${b.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ proof }),
    }), 403)).error.code).toBe('invalid_proof');
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ proof: 'tampered.sig' }),
    }), 403)).error.code).toBe('invalid_proof');

    // Trading the valid proof on the main domain reveals the real title and persists it via __Host-as_unlock_meta.
    const traded = await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ proof }),
    });
    expect(await json(traded, 200)).toEqual({ title: 'Manual Unlock' });
    const metaCookie = cookieFrom(traded, 'as_unlock_meta');
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: metaCookie } }), 200)).title).toBe('Manual Unlock');

    // Self-heal via __proof=1: existing content-host unlock cookie emits a proof in iframe, strips __proof,
    // while un-unlocked visitors still get the normal 401 unlock form (not cookiesBlockedPage) and public redirects.
    const heal = await fetchRaw(`${a.content_url}?__lang=en&__proof=1`, { headers: { cookie: unlockCookie, 'sec-fetch-dest': 'iframe' } });
    expect(heal.status).toBe(200);
    const healHtml = await heal.text();
    expect(healHtml).toContain('data-next="/"');
    const healProof = healHtml.match(/data-proof="([^"]+)"/)?.[1];
    expect(healProof).toBeDefined();
    expect(await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ proof: healProof }),
    }), 200)).toEqual({ title: 'Manual Unlock' });

    const healLocked = await fetchRaw(`${a.content_url}?__lang=en&__proof=1`, { headers: { 'sec-fetch-dest': 'iframe' } });
    expect(healLocked.status).toBe(401);
    const healLockedHtml = await healLocked.text();
    expect(healLockedHtml).toContain('/__share/unlock');
    expect(healLockedHtml).toContain('name="next" value="/"');
    expect(healLockedHtml).not.toContain('__proof');
    expect(healLockedHtml).not.toContain('data-proof=');

    // __proof=1 for unlocked non-iframe/HEAD, owner, public, and private (no existence oracle).
    for (const reqInit of nonIframe) {
      const strip = await fetchRaw(`${a.content_url}?__proof=1`, reqInit);
      expect(strip.status).toBe(302);
      expect(strip.headers.get('location')).toBe('/');
    }
    const healOwner = await fetchRaw(`${a.content_url}?__proof=1`, { headers: { cookie: ownerCookie, 'sec-fetch-dest': 'iframe' } });
    expect(healOwner.status).toBe(302);
    expect(healOwner.headers.get('location')).toBe('/');

    const healPub = await fetchRaw(`${pub.content_url}?__proof=1`, { headers: { 'sec-fetch-dest': 'iframe' } });
    expect(healPub.status).toBe(302);
    expect(healPub.headers.get('location')).toBe('/');

    const priv = await createHtml('<p>priv</p>', '?visibility=private&title=Hidden');
    const healPriv = await fetchRaw(`${priv.content_url}?__proof=1`, { headers: { 'sec-fetch-dest': 'iframe' } });
    expect(healPriv.status).toBe(404);
    expect(await healPriv.text()).not.toContain('data-proof=');

    // Resetting the access code immediately invalidates previously issued proofs too.
    await json(await api(`/api/v1/artifacts/${a.id}/password/reset`, { method: 'POST' }), 200);
    expect((await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ip },
      body: JSON.stringify({ proof }),
    }), 403)).error.code).toBe('invalid_proof');
  });
});

describe('viewer language passed to the iframe', () => {
  it('lets __lang override Accept-Language and keeps it out of the artifact', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const zhBrowser = { 'accept-language': 'zh-CN' };

    const page = await fetchRaw(`${a.content_url}?__lang=en&x=1`, { headers: zhBrowser });
    const html = await page.text();
    expect(html).toContain('Enter access code');
    expect(html).toContain('name="__lang" value="en"');
    expect(html).toContain('name="next" value="/?x=1"'); // __lang is not passed on to the artifact

    // A failed attempt re-renders in the viewer's language (carried in the form, not the header).
    const wrong = await fetchRaw(`${a.content_url}__share/unlock`, {
      method: 'POST',
      headers: { ...zhBrowser, 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '7.7.7.7' },
      body: new URLSearchParams({ code: 'AAAAAA', next: '/', __lang: 'en' }),
    });
    expect(await wrong.text()).toContain('Incorrect access code.');

    // ?pwd= redirect strips both gateway parameters.
    const ok = await fetchRaw(`${a.content_url}?pwd=${a.password}&__lang=en&x=1`, { headers: zhBrowser });
    expect(ok.status).toBe(302);
    expect(await afterCheck(ok, 'as_unlock', a.content_url)).toBe('/?x=1');
  });

  it('ignores unknown __lang values', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const page = await fetchRaw(`${a.content_url}?__lang=fr`, { headers: { 'accept-language': 'en' } });
    expect(await page.text()).toContain('Enter access code');
  });
});

describe('review regressions (round 3)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const login = async () => {
    const res = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { ...jsonHeaders, ...ORIGIN }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
    expect(res.status).toBe(200);
    return cookieFrom(res, 'as_session');
  };

  it('an abort that loses to a commit leaves the live version intact', async () => {
    const { env } = await import('cloudflare:workers');
    const { abortUpload } = await import('../src/lib/store');
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ artifact_id: a.id }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>v2</p>' }), 200);
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 200);
    await abortUpload(env as any, row); // stale abort (e.g. client timed out and sent DELETE)
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<p>v2</p>');
  });

  it('a commit that loses to an abort fails instead of publishing missing files', async () => {
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ artifact_id: a.id }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>v2</p>' }), 200);
    const { env } = await import('cloudflare:workers');
    const { abortUpload, commitUpload, getSettings } = { ...(await import('../src/lib/store')), ...(await import('../src/lib/settings')) };
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    await abortUpload(env as any, row);
    await expect(commitUpload(env as any, row, await getSettings(env as any))).rejects.toThrow(); // files gone / session aborted
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<p>v1</p>');
  });

  it('the commit transaction refuses once the upload session is gone, even with files present', async () => {
    const { env } = await import('cloudflare:workers');
    const { commitUpload } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ artifact_id: a.id }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>v2</p>' }), 200);
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    await env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(up.upload_id).run(); // abort consumed the session first
    await expect(commitUpload(env as any, row, await getSettings(env as any))).rejects.toThrow(/aborted/);
    const after = await json(await api(`/api/v1/artifacts/${a.id}`), 200);
    expect(after.current_version).toBe(1);
  });

  it('signing out revokes owner access on the content subdomain', async () => {
    const a = await createHtml('<p>mine</p>');
    const s2 = await login();
    const hop = await fetchRaw(`${MAIN}/handoff?id=${a.id}&next=/`, { headers: { cookie: s2 } });
    const auth = await fetchRaw(hop.headers.get('location')!);
    const owner = cookieFrom(auth, 'as_owner');
    expect(await (await fetchRaw(a.content_url, { headers: { cookie: owner } })).text()).toBe('<p>mine</p>');

    await fetchRaw(`${MAIN}/api/auth/logout`, { method: 'POST', headers: { cookie: s2, ...ORIGIN } });
    const after = await fetchRaw(a.content_url, { headers: { cookie: owner } });
    expect(after.status).toBe(404);
    await after.arrayBuffer();
  });

  it('rate-limits parallel login guesses', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetchRaw(`${MAIN}/api/auth/login`, {
          method: 'POST',
          headers: { ...jsonHeaders, ...ORIGIN, 'cf-connecting-ip': '5.5.5.5' },
          body: JSON.stringify({ username: 'admin', password: 'wrong guess' }),
        }).then(async (r) => (await r.arrayBuffer(), r.status)),
      ),
    );
    expect(results.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });

  it('re-issues the session cookie when sliding the expiry', async () => {
    const { env } = await import('cloudflare:workers');
    const s3 = await login();
    const raw = decodeURIComponent(s3.split('=').slice(1).join('='));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) + 3600, hash).run();
    const res = await fetchRaw(`${MAIN}/api/auth/me`, { headers: { cookie: s3 } });
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-as_session=') && c.includes('Max-Age=2592000'))).toBe(true);
    await res.arrayBuffer();
  });

  it('serves a subdirectory entry at its own URL', async () => {
    const form = new FormData();
    form.append('file', new File(['<link rel=stylesheet href=../assets/s.css>'], 'pages/home.html'));
    form.append('file', new File(['a{}'], 'assets/s.css'));
    const a = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    expect(a.entry).toBe('pages/home.html');
    const res = await fetchRaw(a.content_url);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/pages/home.html');
  });

  it('answers a failed If-Match with 412, not 304', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=public');
    const res = await fetchRaw(`${a.content_url}index.html`, { headers: { 'if-match': '"stale"' } });
    expect(res.status).toBe(412);
  });

  it('shows a way out when the browser drops the iframe cookie', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const blocked = await fetchRaw(`${a.content_url}?__chk=1&__lang=en`);
    expect(blocked.status).toBe(200);
    const html = await blocked.text();
    expect(html).toContain('Open in a new tab');
    expect(html).toContain(`href="${a.content_url}"`);
    expect(html).toContain('target="_blank"');

    const priv = await createHtml('<p>x</p>');
    const blockedOwner = await (await fetchRaw(`${priv.content_url}?__chk=1`)).text();
    expect(blockedOwner).toContain('/handoff?id='); // owner gets a top-level sign-in link
  });
});

describe('downloads from the share page', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const setVisitorDownload = async (on: boolean) =>
    json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify({ visitor_download_enabled: on }) }), 200);
  const meta = async (pid: string, cookie?: string) => json(await fetchRaw(`${MAIN}/api/public/artifacts/${pid}`, { headers: cookie ? { cookie } : {} }), 200);
  const dl = (pid: string, opts: { cookie?: string; token?: string } = {}) =>
    fetchRaw(`${MAIN}/s/${pid}/download${opts.token ? `?token=${encodeURIComponent(opts.token)}` : ''}`, { headers: opts.cookie ? { cookie: opts.cookie } : {} });

  it('is off for visitors by default, always on for the owner', async () => {
    const a = await createHtml('<p>dl</p>', '?visibility=public&title=Report%202026');
    expect((await meta(a.public_id)).download).toBeNull();
    const denied = await dl(a.public_id);
    expect(denied.status).toBe(403);
    await denied.arrayBuffer();

    const mine = await meta(a.public_id, session);
    expect(mine.download).toMatchObject({ kind: 'html', needs_code: false, name: 'Report 2026.html', file_count: 1 });
    const res = await dl(a.public_id, { cookie: session });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''Report%202026.html");
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('<p>dl</p>');
  });

  it('downloads a multi-file artifact as a ZIP of every file', async () => {
    const form = new FormData();
    form.append('file', new File(['<script src="js/app.js"></script>'], 'site/index.html'));
    form.append('file', new File(['console.log("hi")'], 'site/js/app.js'));
    const bin = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
    form.append('file', new File([bin], 'site/img/pic.png'));
    const a = await json(await api('/api/v1/artifacts?visibility=private&title=My%20Site', { method: 'POST', body: form }), 201);

    const m = await meta(a.public_id, session);
    expect(m.download).toMatchObject({ kind: 'zip', name: 'My Site.zip', file_count: 3 });
    const res = await dl(a.public_id, { cookie: session });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(['img/pic.png', 'index.html', 'js/app.js']);
    expect(strFromU8(files['js/app.js'])).toBe('console.log("hi")');
    expect(files['img/pic.png']).toEqual(bin);

    // private: visitors can't even see it
    const anon = await dl(a.public_id);
    expect(anon.status).toBe(404);
    await anon.arrayBuffer();
  });

  it('lets visitors download when enabled; access-code artifacts need the code', async () => {
    await setVisitorDownload(true);
    try {
      const pub = await createHtml('<p>pub</p>', '?visibility=public');
      expect((await meta(pub.public_id)).download).toMatchObject({ kind: 'html', needs_code: false });
      expect(await (await dl(pub.public_id)).text()).toBe('<p>pub</p>');

      const locked = await createHtml('<p>locked</p>', '?visibility=password&title=Hidden');
      const lm = await meta(locked.public_id);
      expect(lm.download).toEqual({ kind: 'html', needs_code: true }); // no name/size before the code
      const noToken = await dl(locked.public_id);
      expect(noToken.status).toBe(403);
      await noToken.arrayBuffer();

      const token = (code: string) =>
        fetchRaw(`${MAIN}/api/public/artifacts/${locked.public_id}/download-token`, {
          method: 'POST',
          headers: { ...jsonHeaders, 'cf-connecting-ip': '6.6.6.6' },
          body: JSON.stringify({ code }),
        });
      const wrong = await token('AAAAAA');
      expect(wrong.status).toBe(403);
      expect((await wrong.json<any>()).error.code).toBe('incorrect_code');

      const ok = await json(await token(locked.password.toLowerCase()), 200);
      expect(ok).toMatchObject({ kind: 'html', name: 'Hidden.html' });
      expect(await (await dl(locked.public_id, { token: ok.token })).text()).toBe('<p>locked</p>');

      // regenerating the code invalidates outstanding download tokens
      await json(await api(`/api/v1/artifacts/${locked.id}/password/reset`, { method: 'POST' }), 200);
      const stale = await dl(locked.public_id, { token: ok.token });
      expect(stale.status).toBe(403);
      await stale.arrayBuffer();
    } finally {
      await setVisitorDownload(false);
    }
  });
});

describe('admin username', () => {
  const jsonHeaders = { 'content-type': 'application/json', ...ORIGIN };
  const login = (username: string, password: string, ip = '8.8.4.4') =>
    fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { ...jsonHeaders, 'cf-connecting-ip': ip }, body: JSON.stringify({ username, password }) });

  it('requires the right username, case-insensitively, without saying which part was wrong', async () => {
    const bad = await login('root', 'correct horse battery');
    expect(bad.status).toBe(401);
    expect((await bad.json<any>()).error.message).toBe('Incorrect username or password');
    const ok = await login('ADMIN', 'correct horse battery');
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    const missing = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ password: 'correct horse battery' }) });
    expect(missing.status).toBe(400);
    await missing.arrayBuffer();
  });

  it('can be changed with the current password', async () => {
    const put = (body: object) => fetchRaw(`${MAIN}/api/settings/username`, { method: 'PUT', headers: { ...jsonHeaders, cookie: session }, body: JSON.stringify(body) });
    let res = await put({ username: 'owner', current_password: 'nope' });
    expect(res.status).toBe(403);
    expect((await res.json<any>()).error.code).toBe('wrong_current_password');
    res = await put({ username: 'bad name!', current_password: 'correct horse battery' });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    // API tokens can't change it
    res = await fetchRaw(`${MAIN}/api/settings/username`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    expect(res.status).toBe(403);
    await res.arrayBuffer();

    res = await put({ username: 'owner', current_password: 'correct horse battery' });
    expect(await res.json()).toEqual({ ok: true, username: 'owner' });
    expect((await json(await fetchRaw(`${MAIN}/api/auth/me`, { headers: { cookie: session } }), 200)).username).toBe('owner');
    expect((await login('admin', 'correct horse battery', '8.8.4.5')).status).toBe(401);
    const ok = await login('Owner', 'correct horse battery', '8.8.4.5');
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();

    // restore for other tests
    await (await put({ username: 'admin', current_password: 'correct horse battery' })).arrayBuffer();
  });
});

describe('login Turnstile', () => {
  // Run the app directly with Turnstile configured (the shared test env has it off), and stub siteverify.
  const TS_ENV = async () => ({ ...(await import('cloudflare:workers')).env, TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' });
  const call = async (path: string, init: RequestInit = {}) => {
    const { app } = await import('../src/main/app');
    const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${MAIN}${path}`, init), await TS_ENV(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const ip = { 'cf-connecting-ip': '9.9.8.8' };
  const attempt = (password: string, turnstile_token?: string) =>
    call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', ...ORIGIN, ...ip }, body: JSON.stringify({ username: 'admin', password, turnstile_token }) });

  afterEach(() => vi.restoreAllMocks());

  it('kicks in after 3 failures and is verified server-side', async () => {
    const verify = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      const form = init!.body as FormData;
      expect(form.get('secret')).toBe('secret-key');
      expect(form.get('remoteip')).toBe('9.9.8.8');
      return Response.json({ success: form.get('response') === 'good-token' });
    });

    let m = await (await call('/api/auth/methods', { headers: ip })).json<any>();
    expect(m.turnstile).toEqual({ site_key: 'site-key', required: false });

    for (let i = 0; i < 3; i++) expect((await attempt('wrong')).status).toBe(401);
    expect(verify).not.toHaveBeenCalled(); // not needed yet

    m = await (await call('/api/auth/methods', { headers: ip })).json<any>();
    expect(m.turnstile.required).toBe(true);

    // Now even the right password needs a valid token.
    let res = await attempt('correct horse battery');
    expect(res.status).toBe(403);
    expect((await res.json<any>()).error.code).toBe('turnstile_required');
    res = await attempt('correct horse battery', 'bad-token');
    expect(res.status).toBe(403);
    await res.arrayBuffer();
    res = await attempt('correct horse battery', 'good-token');
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('fails closed when siteverify is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const hdr = { 'content-type': 'application/json', ...ORIGIN, 'cf-connecting-ip': '9.9.8.9' };
    for (let i = 0; i < 3; i++) {
      const r = await call('/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'admin', password: 'x' }) });
      await r.arrayBuffer();
    }
    const res = await call('/api/auth/login', { method: 'POST', headers: hdr, body: JSON.stringify({ username: 'admin', password: 'correct horse battery', turnstile_token: 't' }) });
    expect(res.status).toBe(403);
    await res.arrayBuffer();
  });

  it('allows Turnstile through the admin CSP', async () => {
    const res = await fetchRaw(`${MAIN}/`);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    await res.arrayBuffer();
  });
});

describe('access-code attempts: messages, window, Turnstile', () => {
  const unlock = (a: any, code: string, ip: string, extra: Record<string, string> = {}, lang = 'zh') =>
    fetchRaw(`${a.content_url}__share/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
      body: new URLSearchParams({ code, next: '/', __lang: lang, ...extra }),
    });

  it('says how many attempts are left, then how long to wait', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    let res = await unlock(a, 'AAAAAA', '4.4.4.1');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('访问码不正确，还可以再试 4 次。');
    for (let i = 0; i < 3; i++) await (await unlock(a, 'AAAAAA', '4.4.4.1')).arrayBuffer();
    res = await unlock(a, 'AAAAAA', '4.4.4.1', {}, 'en'); // 5th failure: no attempts left
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(500);
    expect(await res.text()).toContain('Too many attempts. Try again in 10 minute(s).');
  });

  it('starts the window at the first failure and resets after it ends', async () => {
    const { env } = await import('cloudflare:workers');
    const a = await createHtml('<p>x</p>', '?visibility=password');
    for (let i = 0; i < 5; i++) await (await unlock(a, 'AAAAAA', '4.4.4.2')).arrayBuffer();
    const row = await env.DB.prepare('SELECT fails, reset_at FROM rate_limits WHERE bucket = ?').bind(`unlock:${a.id}:4.4.4.2`).first<any>();
    expect(row.fails).toBe(5);
    expect(row.reset_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(590); // ~10 min from the first failure
    expect((await unlock(a, a.password, '4.4.4.2')).status).toBe(429);
    // window over → counting starts again
    await env.DB.prepare('UPDATE rate_limits SET reset_at = ? WHERE bucket = ?').bind(Math.floor(Date.now() / 1000) - 1, `unlock:${a.id}:4.4.4.2`).run();
    expect((await unlock(a, a.password, '4.4.4.2')).status).toBe(303);
  });

  it('reports remaining attempts and wait time to the download popover', async () => {
    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitor_download_enabled: true }) }), 200);
    try {
      const a = await createHtml('<p>x</p>', '?visibility=password');
      const tok = (code: string) =>
        fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}/download-token`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '4.4.4.3' }, body: JSON.stringify({ code }) });
      let res = await tok('AAAAAA');
      expect((await res.json<any>()).error).toMatchObject({ code: 'incorrect_code', remaining: 4 });
      for (let i = 0; i < 4; i++) await (await tok('AAAAAA')).arrayBuffer();
      res = await tok(a.password);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await res.json<any>()).error).toMatchObject({ code: 'rate_limited' });
    } finally {
      await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitor_download_enabled: false }) }), 200);
    }
  });

  describe('with Turnstile configured', () => {
    // Call the worker directly with Turnstile keys (off in the shared test env) and stub siteverify.
    const worker = async (url: string, init: RequestInit = {}) => {
      const { default: handler } = await import('../src/index');
      const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
      const base = (await import('cloudflare:workers')).env;
      const ctx = createExecutionContext();
      const res = await handler.fetch(new Request(url, { redirect: 'manual', ...init }) as any, { ...base, TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' } as any, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const post = (a: any, body: Record<string, string>) =>
      worker(`${a.content_url}__share/unlock`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '4.4.4.9' }, body: new URLSearchParams({ next: '/', __lang: 'en', ...body }) });

    afterEach(() => vi.restoreAllMocks());

    it('shows Turnstile on the unlock page after 3 failures and verifies it', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => Response.json({ success: (init!.body as FormData).get('response') === 'good' }));
      const a = await createHtml('<p>secret</p>', '?visibility=password');
      for (let i = 0; i < 3; i++) await (await post(a, { code: 'AAAAAA' })).arrayBuffer();

      const page = await worker(a.content_url, { headers: { 'cf-connecting-ip': '4.4.4.9' } });
      const html = await page.text();
      expect(html).toContain('class="cf-turnstile" data-sitekey="site-key"');
      expect(page.headers.get('content-security-policy')).toContain('script-src https://challenges.cloudflare.com');

      let res = await post(a, { code: a.password });
      expect(res.status).toBe(403); // no token
      expect(await res.text()).toContain('Complete the verification first.');
      res = await post(a, { code: a.password, 'cf-turnstile-response': 'bad' });
      expect(res.status).toBe(403);
      await res.arrayBuffer();
      res = await post(a, { code: a.password, 'cf-turnstile-response': 'good' });
      expect(res.status).toBe(303);
    });

    it('keeps the code from a ?pwd= link when Turnstile is needed', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: false }));
      const a = await createHtml('<p>secret</p>', '?visibility=password');
      for (let i = 0; i < 3; i++) await (await post(a, { code: 'AAAAAA' })).arrayBuffer();
      const res = await worker(`${a.content_url}?pwd=${a.password}`, { headers: { 'cf-connecting-ip': '4.4.4.9' } });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain(`value="${a.password}"`);
      expect(html).toContain('cf-turnstile');
    });
  });
});

describe('review regressions (round 4)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };

  it('counts views loaded in the share page iframe', async () => {
    const a = await createHtml('<p>v</p>', '?visibility=public');
    await (await fetchRaw(a.content_url, { headers: { 'sec-fetch-dest': 'iframe', 'user-agent': BROWSER_UA } })).arrayBuffer();
    let views = 0;
    for (let i = 0; i < 20 && views < 1; i++) {
      views = (await json(await api(`/api/v1/artifacts/${a.id}`), 200)).view_count;
      if (!views) await new Promise((r) => setTimeout(r, 25));
    }
    expect(views).toBe(1);
  });

  it('issues a fresh code when an artifact re-enters password mode', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const cookie = cookieFrom(await fetchRaw(`${a.content_url}?pwd=${a.password}`), 'as_unlock');
    await json(await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ visibility: 'private' }) }), 200);
    const back = await json(await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ visibility: 'password' }) }), 200);
    expect(back.password).not.toBe(a.password);
    const res = await fetchRaw(a.content_url, { headers: { cookie } });
    expect(res.status).toBe(401); // old unlock cookie revoked
    await res.arrayBuffer();
    // staying in password mode while changing other fields keeps the code
    const same = await json(await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ title: 't' }) }), 200);
    expect(same.password).toBe(back.password);
  });

  it('does not reveal private artifacts through the cookie-check hop', async () => {
    const a = await createHtml('<p>x</p>');
    const res = await fetchRaw(`${a.content_url}?__chk=1`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('new tab');
  });

  it('strips __lang before serving the artifact to an unlocked visitor', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const cookie = cookieFrom(await fetchRaw(`${a.content_url}?pwd=${a.password}`), 'as_unlock');
    const res = await fetchRaw(`${a.content_url}?__lang=en&x=1`, { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?x=1');
  });

  it('clamps Content-Range to the file size', async () => {
    const a = await createHtml('0123456789', '?visibility=public');
    const res = await fetchRaw(`${a.content_url}index.html`, { headers: { range: 'bytes=5-99999' } });
    if (res.status === 206) expect(res.headers.get('content-range')).toBe('bytes 5-9/10');
    else expect(res.status).toBe(416);
    await res.arrayBuffer();
  });

  it('rejects a non-numeric version parameter', async () => {
    const a = await createHtml('<p>x</p>');
    for (const v of ['latest', '0', '-1', '1.5']) {
      const res = await api(`/api/v1/artifacts/${a.id}/files?version=${v}`);
      expect(res.status, v).toBe(400);
      await res.arrayBuffer();
    }
  });

  it('enforces the per-version file limit with the upload counter', async () => {
    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify({ max_version_files: 2 }) }), 200);
    try {
      const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: '{}' }), 201);
      const put = (p: string) => api(`/api/v1/uploads/${up.upload_id}/files/${p}`, { method: 'PUT', body: 'x' });
      expect((await put('a.html')).status).toBe(200);
      expect((await put('b.html')).status).toBe(200);
      expect((await put('a.html')).status).toBe(200); // re-upload of a known path doesn't count
      const third = await put('c.html');
      expect(third.status).toBe(413);
      await third.arrayBuffer();
    } finally {
      await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify({ max_version_files: 2000 }) }), 200);
    }
  });
});

describe('review regressions (round 5)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const setSetting = async (patch: object) => json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify(patch) }), 200);

  it('caps an un-sized (chunked) HTML body instead of buffering it whole', async () => {
    await setSetting({ max_file_bytes: 1024 });
    try {
      const chunk = new TextEncoder().encode('x'.repeat(512));
      const body = new ReadableStream({
        start(ctrl) {
          for (let i = 0; i < 4; i++) ctrl.enqueue(chunk);
          ctrl.close();
        },
      });
      const res = await (exports as any).default.fetch(
        new Request(`${MAIN}/api/v1/artifacts`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/html' }, body, duplex: 'half' } as any),
      );
      expect(res.status).toBe(413);
      await res.arrayBuffer();
    } finally {
      await setSetting({ max_file_bytes: 100 * 1024 * 1024 });
    }
  });

  it('rejects a non-object multipart meta field with 400', async () => {
    const form = new FormData();
    form.append('meta', 'null');
    form.append('file', new File(['<p>x</p>'], 'index.html'));
    const res = await api('/api/v1/artifacts', { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe('invalid_meta');
  });

  it('keeps a published version immutable to late uploads', async () => {
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ artifact_id: a.id }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>v2</p>' }), 200);
    const { env } = await import('cloudflare:workers');
    const { putUploadFile, commitUpload } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    const settings = await getSettings(env as any);
    await commitUpload(env as any, row, settings);
    await expect(putUploadFile(env as any, row, 'late.html', '<p>late</p>', settings)).rejects.toThrow(/already committed/);
    const files = await json(await api(`/api/v1/artifacts/${a.id}/files`), 200);
    expect(files.items.map((f: any) => f.path)).toEqual(['index.html']);
  });

  it('does not count the owner previewing their own artifact', async () => {
    const a = await createHtml('<p>mine</p>');
    const hop = await fetchRaw(`${MAIN}/handoff?id=${a.id}&next=/`, { headers: { cookie: session } });
    const owner = cookieFrom(await fetchRaw(hop.headers.get('location')!), 'as_owner');
    await (await fetchRaw(a.content_url, { headers: { cookie: owner, 'sec-fetch-dest': 'iframe' } })).arrayBuffer();
    await new Promise((r) => setTimeout(r, 50));
    expect((await json(await api(`/api/v1/artifacts/${a.id}`), 200)).view_count).toBe(0);
  });

  it('leaves access codes out of artifact lists', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password&title=ListCode');
    const list = await json(await api('/api/v1/artifacts?q=ListCode'), 200);
    expect(list.items.find((i: any) => i.id === a.id).password).toBeNull();
    expect((await json(await api(`/api/v1/artifacts/${a.id}`), 200)).password).toBe(a.password);
  });

  it('answers a download pre-check with JSON', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=public');
    expect(await json(await fetchRaw(`${MAIN}/s/${a.public_id}/download?check=1`, { headers: { cookie: session } }), 200)).toEqual({ ok: true });
    const denied = await fetchRaw(`${MAIN}/s/${a.public_id}/download?check=1`); // visitors: downloads off by default
    expect(denied.status).toBe(403);
    expect((await denied.json<any>()).error.code).toBe('download_disabled');
  });

  it('keeps cleaning up when one step fails', async () => {
    const { env } = await import('cloudflare:workers');
    const { runCleanup } = await import('../src/cron');
    const t = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO uploads (id, artifact_id, version, is_new, meta, created_at, expires_at) VALUES ('stale-up', 'no-such-artifact', 1, 1, '{}', ?, ?)").bind(t - 90000, t - 10).run();
    await env.DB.prepare("INSERT INTO artifact_versions (artifact_id, version, status, created_at) VALUES ('no-such-artifact', 1, 'uploading', ?)").bind(t - 90000).run();
    await env.DB.prepare("INSERT INTO sessions (id, method, created_at, expires_at) VALUES ('expired-session', 'password', ?, ?)").bind(t - 100, t - 1).run();
    const brokenBucket = new Proxy(env.BUCKET, { get: (target, prop) => (prop === 'list' ? () => Promise.reject(new Error('R2 down')) : (target as any)[prop]) });
    await runCleanup({ ...(env as any), BUCKET: brokenBucket });
    // the R2-dependent steps failed, but expired sessions were still removed
    expect(await env.DB.prepare("SELECT 1 FROM sessions WHERE id = 'expired-session'").first()).toBeNull();
  });
});

describe('review regressions (round 6)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const setSetting = async (patch: object) => json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify(patch) }), 200);

  it('never retires the live version, even if it became live after being picked', async () => {
    const { env } = await import('cloudflare:workers');
    const { retireVersion } = await import('../src/lib/store');
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    await json(await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>v2</p>' }), 200);
    await json(await api(`/api/v1/artifacts/${a.id}/versions/1/activate`, { method: 'POST' }), 200); // rollback: v1 live again
    expect(await retireVersion(env as any, a.id, 1)).toBe(false);
    expect(await (await fetchRaw(a.content_url)).text()).toBe('<p>v1</p>');
    expect(await retireVersion(env as any, a.id, 2)).toBe(true);
  });

  it('gives a file slot back when the write fails', async () => {
    await setSetting({ max_version_files: 2, max_file_bytes: 1024 });
    try {
      const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: '{}' }), 201);
      const put = (p: string, body: string) => api(`/api/v1/uploads/${up.upload_id}/files/${p}`, { method: 'PUT', body });
      for (let i = 0; i < 3; i++) {
        const big = await put('a.html', 'x'.repeat(2048)); // fails after taking a slot
        expect(big.status).toBe(413);
        await big.arrayBuffer();
      }
      expect((await put('a.html', 'ok')).status).toBe(200);
      expect((await put('b.html', 'ok')).status).toBe(200);
    } finally {
      await setSetting({ max_version_files: 2000, max_file_bytes: 100 * 1024 * 1024 });
    }
  });

  it('turns backslash separators into folders', async () => {
    const form = new FormData();
    form.append('file', new File(['<p>i</p>'], 'index.html'));
    form.append('file', new File(['<p>b</p>'], 'docs\\b.html'));
    const a = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    const files = await json(await api(`/api/v1/artifacts/${a.id}/files`), 200);
    expect(files.items.map((f: any) => f.path)).toEqual(['docs/b.html', 'index.html']);
  });

  it('cleans up the files of an aborted version before dropping its row', async () => {
    const { env } = await import('cloudflare:workers');
    const { runCleanup } = await import('../src/cron');
    const t = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO artifact_versions (artifact_id, version, status, created_at) VALUES ('leaky', 7, 'aborted', ?)").bind(t - 90000).run();
    await env.BUCKET.put('a/leaky/v7/x.html', 'left behind');
    await runCleanup(env as any);
    expect(await env.BUCKET.head('a/leaky/v7/x.html')).toBeNull();
    // no artifact exists for it (a first upload that never committed): nothing to protect, row dropped
    expect(await env.DB.prepare("SELECT 1 FROM artifact_versions WHERE artifact_id = 'leaky'").first()).toBeNull();
  });
});

describe('review regressions (round 7)', () => {
  it('refuses to activate a version that was retired meanwhile', async () => {
    const { env } = await import('cloudflare:workers');
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    await json(await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>v2</p>' }), 200);
    // simulate the cleanup retiring v1 right after the activate handler checked it
    const { versionEntryAndKind } = await import('../src/lib/store');
    const spy = vi.spyOn(await import('../src/lib/store'), 'versionEntryAndKind').mockImplementation(async (e: any, art: any, v: number) => {
      const r = await versionEntryAndKind(e, art, v);
      await env.DB.prepare('DELETE FROM artifact_versions WHERE artifact_id = ? AND version = ?').bind(art.id, v).run();
      return r;
    });
    try {
      const res = await api(`/api/v1/artifacts/${a.id}/versions/1/activate`, { method: 'POST' });
      expect(res.status).toBe(404);
      await res.arrayBuffer();
    } finally {
      spy.mockRestore();
    }
    expect((await json(await api(`/api/v1/artifacts/${a.id}`), 200)).current_version).toBe(2);
  });

  it('publishes a single non-HTML file as its own entry', async () => {
    const form = new FormData();
    form.append('file', new File(['%PDF-1.4'], 'report.pdf'));
    const a = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    expect(a.entry).toBe('report.pdf');
    const res = await fetchRaw(a.content_url);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(await res.text()).toBe('%PDF-1.4');
  });

  it('reports a storage failure as 500, not 416', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=public');
    const { default: handler } = await import('../src/index');
    const { createExecutionContext } = await import('cloudflare:test');
    const base = (await import('cloudflare:workers')).env as any;
    const bucket = new Proxy(base.BUCKET, { get: (t, p) => (p === 'get' ? () => Promise.reject(new Error('R2 down')) : (t as any)[p]) });
    const res = await handler.fetch(new Request(`${a.content_url}index.html`) as any, { ...base, BUCKET: bucket }, createExecutionContext());
    expect(res.status).toBe(500);
    await res.arrayBuffer();
  });

  it('fails a ZIP download instead of shipping an empty file for a missing object', async () => {
    const { env } = await import('cloudflare:workers');
    const form = new FormData();
    form.append('file', new File(['<p>i</p>'], 'index.html'));
    form.append('file', new File(['a{}'], 's.css'));
    const a = await json(await api('/api/v1/artifacts', { method: 'POST', body: form }), 201);
    await env.BUCKET.delete(`a/${a.id}/v1/s.css`);
    const res = await fetchRaw(`${MAIN}/s/${a.public_id}/download`, { headers: { cookie: session } });
    expect(res.status).toBe(200); // headers are sent before the body streams
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});

describe('review regressions (round 8)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };

  it('signs out every other session when the password changes', async () => {
    const login = await fetchRaw(`${MAIN}/api/auth/login`, { method: 'POST', headers: { ...jsonHeaders, ...ORIGIN }, body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }) });
    const other = cookieFrom(login, 'as_session');
    const change = (from: string, to: string) =>
      fetchRaw(`${MAIN}/api/settings/password`, { method: 'PUT', headers: { ...jsonHeaders, ...ORIGIN, cookie: session }, body: JSON.stringify({ current_password: from, new_password: to }) });
    expect((await change('correct horse battery', 'new horse battery')).status).toBe(200);
    try {
      const res = await fetchRaw(`${MAIN}/api/auth/me`, { headers: { cookie: other } });
      expect(res.status).toBe(401); // the other session is gone
      await res.arrayBuffer();
      expect((await fetchRaw(`${MAIN}/api/auth/me`, { headers: { cookie: session } })).status).toBe(200); // ours stays
    } finally {
      expect((await change('new horse battery', 'correct horse battery')).status).toBe(200);
    }
  });

  it('redirects a share link with a trailing slash', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=public');
    const res = await fetchRaw(`${a.url}/?pwd=ABC`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`/s/${a.public_id}?pwd=ABC`);
  });

  it('drops OS junk files sent through upload sessions', async () => {
    const up = await json(
      await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ files: ['index.html', '.DS_Store', '__MACOSX/._index.html'] }) }),
      201,
    );
    expect(await json(await api(`/api/v1/uploads/${up.upload_id}/files/.DS_Store`, { method: 'PUT', body: 'junk' }), 200)).toMatchObject({ ignored: true });
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    const a = await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 201); // not waiting for junk
    const files = await json(await api(`/api/v1/artifacts/${a.id}/files`), 200);
    expect(files.items.map((f: any) => f.path)).toEqual(['index.html']);
  });

  it('escapes RFC 5987 specials in the download file name', async () => {
    const a = await createHtml('<p>x</p>', `?title=${encodeURIComponent("Bob's 报告 (v2)")}`);
    const res = await fetchRaw(`${MAIN}/s/${a.public_id}/download`, { headers: { cookie: session } });
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toContain("filename*=UTF-8''Bob%27s%20%E6%8A%A5%E5%91%8A%20%28v2%29.html");
    await res.arrayBuffer();
  });

  it('keeps the link code in the blocked-cookie fallback', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const first = await fetchRaw(`${a.content_url}?pwd=${a.password}`);
    const hop = new URL(first.headers.get('location')!, a.content_url);
    expect(hop.searchParams.get('pwd')).toBe(a.password);
    const blocked = await (await fetchRaw(hop.toString())).text(); // cookie dropped
    expect(blocked).toContain(`?pwd=${a.password}`);
  });
});

describe('review regressions (round 9)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const viewsOf = async (id: string, expected: number) => {
    let v = -1;
    for (let i = 0; i < 20; i++) {
      v = (await json(await api(`/api/v1/artifacts/${id}`), 200)).view_count;
      if (v === expected) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return v;
  };

  it('applies metadata sent with new content together with it', async () => {
    const a = await createHtml('<p>v1</p>', '?visibility=public');
    const b = await json(await api(`/api/v1/artifacts/${a.id}/content?visibility=password&title=Locked`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>v2</p>' }), 200);
    expect(b).toMatchObject({ current_version: 2, visibility: 'password', title: 'Locked' });
    expect(b.password).toMatch(/^[23456789A-Z]{6}$/);
    const anon = await fetchRaw(a.content_url);
    expect(anon.status).toBe(401);
    await anon.arrayBuffer();
  });

  it('updates only the fields being changed (no stale write-back)', async () => {
    const { env } = await import('cloudflare:workers');
    const { patchArtifact } = await import('../src/lib/store');
    const a = await createHtml('<p>x</p>', '?visibility=password');
    const stale = await env.DB.prepare('SELECT * FROM artifacts WHERE id = ?').bind(a.id).first<any>();
    const reset = await json(await api(`/api/v1/artifacts/${a.id}/password/reset`, { method: 'POST' }), 200);
    await patchArtifact(env as any, stale, { title: 'renamed' }); // a PATCH that read the row before the reset
    const now = await json(await api(`/api/v1/artifacts/${a.id}`), 200);
    expect(now.title).toBe('renamed');
    expect(now.password).toBe(reset.password); // the reset survives
  });

  it('answers robots.txt for a private artifact like any miss', async () => {
    const a = await createHtml('<p>x</p>');
    const res = await fetchRaw(`${a.content_url}robots.txt`);
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });

  it('never hands out an aborted version number again, even after cleanup', async () => {
    const { env } = await import('cloudflare:workers');
    const { runCleanup } = await import('../src/cron');
    const a = await createHtml('<p>v1</p>');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ artifact_id: a.id }) }), 201);
    expect(up.version).toBe(2);
    await (await api(`/api/v1/uploads/${up.upload_id}`, { method: 'DELETE' })).arrayBuffer();
    await env.DB.prepare('UPDATE artifact_versions SET created_at = 0 WHERE artifact_id = ? AND version = 2').bind(a.id).run();
    await runCleanup(env as any);
    const next = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ artifact_id: a.id }) }), 201);
    expect(next.version).toBe(3);
  });

  it('counts successful page loads only, including SPA routes', async () => {
    const a = await createHtml('<p>spa</p>', '?visibility=public&spa_fallback=true');
    const get = async (p: string) => (await fetchRaw(`${a.content_url}${p}`, { headers: { 'sec-fetch-dest': 'document', accept: 'text/html', 'user-agent': BROWSER_UA } })).arrayBuffer();
    await get('missing.html'); // SPA fallback → entry, a real page load
    await get('dashboard'); // extension-less SPA route
    expect(await viewsOf(a.id, 2)).toBe(2);

    const b = await createHtml('<p>x</p>', '?visibility=public');
    await (await fetchRaw(`${b.content_url}missing.html`, { headers: { 'sec-fetch-dest': 'document' } })).arrayBuffer(); // 404
    await new Promise((r) => setTimeout(r, 50));
    expect((await json(await api(`/api/v1/artifacts/${b.id}`), 200)).view_count).toBe(0);
  });
});

describe('review regressions (round 10)', () => {
  it('rejects JSON bodies that are not objects with 400', async () => {
    const a = await createHtml('<p>x</p>');
    for (const body of ['null', '[]', '42']) {
      const res = await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body });
      expect(res.status, body).toBe(400);
      await res.arrayBuffer();
    }
    const up = await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    expect(up.status).toBe(400);
    await up.arrayBuffer();
  });

  it('leaves ?pwd= alone on a public artifact (it may use the name itself)', async () => {
    const a = await createHtml('<p>x</p>', '?visibility=public');
    const res = await fetchRaw(`${a.content_url}?pwd=abc&x=1`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it('does not count OS junk toward the declared file limit', async () => {
    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_version_files: 2 }) }), 200);
    try {
      const res = await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['a.html', 'b.html', '.DS_Store', '__MACOSX/._a.html'] }) });
      expect(res.status).toBe(201);
      await res.arrayBuffer();
    } finally {
      await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_version_files: 2000 }) }), 200);
    }
  });

  it('deletes upload sessions before files when purging an artifact', async () => {
    const { env } = await import('cloudflare:workers');
    const { purgeArtifact, putUploadFile } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const a = await createHtml('<p>v1</p>');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifact_id: a.id }) }), 201);
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    await purgeArtifact(env as any, a.id);
    // a PUT that arrives after the purge started can't leave an object behind
    await expect(putUploadFile(env as any, row, 'late.js', 'x', await getSettings(env as any))).rejects.toThrow();
    expect((await env.BUCKET.list({ prefix: `a/${a.id}/` })).objects).toHaveLength(0);
  });
});

describe('review regressions (round 11)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };

  it('publishes only after an in-flight replacement and its metadata are complete', async () => {
    const { env } = await import('cloudflare:workers');
    const { commitUpload, putUploadFile, requireUpload } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ visibility: 'public' }) }), 201);
    const row = await requireUpload(env, up.upload_id);
    const settings = await getSettings(env);
    await putUploadFile(env, row, 'index.html', '<p>original</p>', settings);
    const replacement = '<p>replacement with a different size</p>';
    const bucket = new Proxy(env.BUCKET, {
      get: (target, property) => property === 'put' ? async (key: string, body: string, options: R2PutOptions) => {
        const stored = await target.put(key, body, options);
        await expect(commitUpload(env, row, settings)).rejects.toMatchObject({ code: 'upload_busy' });
        await expect(putUploadFile(env, row, 'index.html', 'overlap', settings)).rejects.toMatchObject({ code: 'file_busy' });
        return stored;
      } : Reflect.get(target, property, target),
    });
    await putUploadFile({ ...env, BUCKET: bucket }, row, 'index.html', replacement, settings);
    await commitUpload(env, row, settings);
    const detail = await json(await api(`/api/v1/artifacts/${up.artifact_id}`), 200);
    expect(detail).toMatchObject({ file_count: 1, total_size: replacement.length });
    expect(await (await fetchRaw(detail.content_url)).text()).toBe(replacement);
  });

  it('rotates the code when a stale password-mode snapshot follows a public switch', async () => {
    const { env } = await import('cloudflare:workers');
    const { patchArtifact, requireArtifact } = await import('../src/lib/store');
    const a = await createHtml('<p>original</p>', '?visibility=password');
    const stale = await requireArtifact(env, a.id);
    await patchArtifact(env, stale, { visibility: 'public' });
    const current = await patchArtifact(env, stale, { visibility: 'password' });
    expect(current.password_ver).toBe(stale.password_ver + 1);
    expect(current.password_enc).not.toBe(stale.password_enc);
  });

  it('keeps a version marked retiring until its files are gone, and finishes later', async () => {
    const { env } = await import('cloudflare:workers');
    const { retireVersion } = await import('../src/lib/store');
    const a = await createHtml('<p>v1</p>');
    await json(await api(`/api/v1/artifacts/${a.id}/content`, { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>v2</p>' }), 200);
    const broken = new Proxy(env.BUCKET, { get: (t, p) => (p === 'list' ? () => Promise.reject(new Error('R2 down')) : (t as any)[p]) });
    await expect(retireVersion({ ...(env as any), BUCKET: broken }, a.id, 1)).rejects.toThrow();
    expect(await env.DB.prepare('SELECT status FROM artifact_versions WHERE artifact_id = ? AND version = 1').bind(a.id).first()).toEqual({ status: 'retiring' });
    const act = await api(`/api/v1/artifacts/${a.id}/versions/1/activate`, { method: 'POST' });
    expect(act.status).toBe(404); // can't go live while retiring
    await act.arrayBuffer();
    expect(await retireVersion(env as any, a.id, 1)).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM artifact_versions WHERE artifact_id = ? AND version = 1').bind(a.id).first()).toEqual({ status: 'purged' });
    expect(await env.BUCKET.head(`a/${a.id}/v1/index.html`)).toBeNull();
  });

  it('rejects an OIDC discovery document for a different issuer', async () => {
    // a fresh Response per call: Workers forbid sharing I/O objects across request contexts
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ issuer: 'https://evil.example', authorization_endpoint: 'https://evil.example/auth', token_endpoint: 'https://evil.example/token', jwks_uri: 'https://evil.example/jwks' }),
    );
    try {
      await json(
        await api('/api/settings/sso/cloudflare', {
          method: 'PUT',
          auth: 'session',
          headers: jsonHeaders,
          body: JSON.stringify({ issuer: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc', client_id: 'abc', client_secret: 's' }),
        }),
        200,
      );
      const res = await fetchRaw(`${MAIN}/api/auth/oauth/cloudflare/start?purpose=bind`, { headers: { cookie: session } });
      expect(res.headers.get('location')).toContain('sso_error=sso_discovery_failed');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects malformed JSON bodies on admin endpoints with 400', async () => {
    const res = await fetchRaw(`${MAIN}/api/v1/tokens`, { method: 'POST', headers: { ...jsonHeaders, ...ORIGIN, cookie: session }, body: '{oops' });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe('invalid_json');
  });
});

describe('publishing and authentication consistency', () => {
  const jsonHeaders = { 'content-type': 'application/json' };

  it('requires a new publication snapshot if a write finishes before the commit transaction', async () => {
    const { env } = await import('cloudflare:workers');
    const { commitUpload, putUploadFile, requireUpload } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: '{}' }), 201);
    const upload = await requireUpload(env, up.upload_id);
    const settings = await getSettings(env);
    await putUploadFile(env, upload, 'index.html', '<p>index</p>', settings);
    let batches = 0;
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'prepare') return target.prepare.bind(target);
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          if (++batches === 2) await putUploadFile(env, upload, 'app.js', 'void 0;', settings);
          return target.batch(statements);
        };
        return Reflect.get(target, property, target);
      },
    });
    await expect(commitUpload({ ...env, DB: database }, upload, settings)).rejects.toMatchObject({ code: 'upload_busy' });
    const published = await commitUpload(env, upload, settings);
    const detail = await json(await api(`/api/v1/artifacts/${published.id}`), 200);
    expect(detail).toMatchObject({ file_count: 2, kind: 'folder' });
  });

  it('rejects an entry that belonged only to the version seen by an older reader', async () => {
    const { env } = await import('cloudflare:workers');
    const { patchArtifact, requireArtifact } = await import('../src/lib/store');
    const a = await createHtml('<p>old</p>', '?filename=old.html');
    const stale = await requireArtifact(env, a.id);
    await json(await api(`/api/v1/artifacts/${a.id}/content?filename=new.html`, {
      method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<p>new</p>',
    }), 200);
    await expect(patchArtifact(env, stale, { entry: 'old.html' })).rejects.toMatchObject({ code: 'invalid_entry' });
    expect((await requireArtifact(env, a.id)).entry).toBe('new.html');
  });

  it('serves cached public files with browser-only caching and honors strict preconditions', async () => {
    const a = await createHtml('<p>cached</p>', '?visibility=public');
    const initial = await fetchRaw(a.content_url);
    const tag = initial.headers.get('etag')!;
    expect(initial.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    await initial.arrayBuffer();
    const cached = await fetchRaw(a.content_url, { headers: { 'if-none-match': `W/${tag}` } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    for (const method of ['GET', 'HEAD']) {
      const strict = await fetchRaw(a.content_url, { method, headers: { 'if-match': `W/${tag}` } });
      expect(strict.status).toBe(412);
    }
    const resume = await fetchRaw(a.content_url, { headers: { range: 'bytes=0-2', 'if-range': '"other-version"' } });
    expect(resume.status).toBe(200);
    expect(await resume.text()).toBe('<p>cached</p>');
    await json(await api(`/api/v1/artifacts/${a.id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ visibility: 'private' }) }), 200);
    const denied = await fetchRaw(a.content_url, { headers: { 'if-none-match': tag } });
    expect(denied.status).toBe(404);
    await denied.arrayBuffer();
  });

  it('guards the last usable login method at the database write', async () => {
    const { env } = await import('cloudflare:workers');
    const { updateSettings } = await import('../src/lib/settings');
    const { setBinding } = await import('../src/main/oauth');
    await setBinding(env, 'github', 'review-test', 'Review test');
    try {
      const results = await Promise.allSettled([
        updateSettings(env, { password_login_enabled: false }),
        setBinding(env, 'github', null, null),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const methods = await json(await fetchRaw(`${MAIN}/api/auth/methods`), 200);
      expect(methods.password || methods.sso.length > 0).toBe(true);
    } finally {
      await updateSettings(env, { password_login_enabled: true });
      await setBinding(env, 'github', null, null);
    }
  });

  it('accepts an OAuth bind callback only from the session that started it', async () => {
    const { env } = await import('cloudflare:workers');
    const other = cookieFrom(await fetchRaw(`${MAIN}/api/auth/login`, {
      method: 'POST', headers: { ...jsonHeaders, ...ORIGIN },
      body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
    }), 'as_session');
    const start = await fetchRaw(`${MAIN}/api/auth/oauth/github/start?purpose=bind`, { headers: { cookie: session } });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = `${MAIN}/api/auth/oauth/github/callback?state=${state}&error=cancelled`;
    const rejected = await fetchRaw(callback, { headers: { cookie: other } });
    expect(rejected.headers.get('location')).toContain('error=sso_state');
    const allowed = await fetchRaw(callback, { headers: { cookie: session } });
    expect(allowed.headers.get('location')).toContain('sso_error=sso_denied');
    expect(await env.DB.prepare('SELECT 1 FROM oauth_states WHERE state = ?').bind(state).first()).toBeNull();
  });

  it('exchanges an OAuth bind callback code without using unsupported RequestInit options and rejects token redirects', async () => {
    const { setBinding } = await import('../src/main/oauth');
    await json(
      await api('/api/settings/sso/github', {
        method: 'PUT',
        auth: 'session',
        headers: jsonHeaders,
        body: JSON.stringify({ client_id: 'gh-client', client_secret: 'gh-secret', enabled: true }),
      }),
      200,
    );
    let tokenResponse = () => Response.json({ access_token: 'gh-access' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      // Construct a real Workers Request so unsupported options (such as redirect: 'error') throw as in production.
      const req = new Request(input, init);
      if (req.url === 'https://github.com/login/oauth/access_token') {
        expect(req.redirect).toBe('manual');
        return tokenResponse();
      }
      if (req.url === 'https://api.github.com/user') {
        expect(req.headers.get('authorization')).toBe('Bearer gh-access');
        return Response.json({ id: 4242, login: 'octocat' });
      }
      throw new Error(`unexpected fetch: ${req.url}`);
    });
    try {
      const start = await fetchRaw(`${MAIN}/api/auth/oauth/github/start?purpose=bind`, { headers: { cookie: session } });
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const ok = await fetchRaw(`${MAIN}/api/auth/oauth/github/callback?state=${state}&code=good-code`, { headers: { cookie: session } });
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toBe('/#/settings?sso_bound=github');

      const list = await json(await api('/api/settings/sso', { auth: 'session' }), 200);
      expect(list.items.find((i: any) => i.provider === 'github')?.bound?.display).toBe('octocat');

      tokenResponse = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
      const start2 = await fetchRaw(`${MAIN}/api/auth/oauth/github/start?purpose=bind`, { headers: { cookie: session } });
      const state2 = new URL(start2.headers.get('location')!).searchParams.get('state')!;
      const redirected = await fetchRaw(`${MAIN}/api/auth/oauth/github/callback?state=${state2}&code=redir-code`, { headers: { cookie: session } });
      expect(redirected.status).toBe(302);
      expect(redirected.headers.get('location')).toContain('sso_error=sso_token');
      expect(redirected.headers.get('location')).toContain('Token%20endpoint%20redirected%20(302)');
    } finally {
      vi.restoreAllMocks();
      await setBinding((await import('cloudflare:workers')).env, 'github', null, null);
    }
  });

  it('downloads an HTML artifact whose title reaches the filename limit with an emoji', async () => {
    const a = await createHtml('<p>unicode</p>', `?title=${encodeURIComponent('x'.repeat(99) + '😀')}`);
    const res = await fetchRaw(`${MAIN}/s/${a.public_id}/download`, { headers: { cookie: session } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('%F0%9F%98%80.html');
    await res.arrayBuffer();
  });
});

describe('review regressions (loop 2, round 2)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };

  it('accepts a large manifest (stored as rows) and still checks it on commit', async () => {
    const { env } = await import('cloudflare:workers');
    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify({ max_version_files: 10000 }) }), 200);
    try {
      // ~2.3 MB as one JSON string — over D1's per-value limit, fine as rows
      const files = ['index.html', ...Array.from({ length: 5000 }, (_, i) => `d-${'x'.repeat(440)}/f-${i}.css`), 'index.html'];
      const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ files }) }), 201);
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id = ?').bind(up.upload_id).first<any>()).n).toBe(5001); // de-duplicated
      await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
      const res = await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect((await res.json<any>()).error.message).toMatch(/^Missing 5000 file\(s\): d-x+\/f-0\.css/);
      await (await api(`/api/v1/uploads/${up.upload_id}`, { method: 'DELETE' })).arrayBuffer();
      expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id = ?').bind(up.upload_id).first<any>()).n).toBe(0);
    } finally {
      await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: jsonHeaders, body: JSON.stringify({ max_version_files: 2000 }) }), 200);
    }
  });

  it('removes the manifest rows once the upload is committed', async () => {
    const { env } = await import('cloudflare:workers');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 201);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id = ?').bind(up.upload_id).first<any>()).n).toBe(0);
  });
});

describe('review regressions (loop 2, round 3)', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const begin = async (files: string[]) => json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ files }) }), 201);

  it('marks the session with its manifest size and refuses to commit while the list is pending', async () => {
    const { env } = await import('cloudflare:workers');
    const up = await begin(['index.html', 'a.css']);
    const row = await env.DB.prepare('SELECT expected, manifest FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    expect(row).toEqual({ expected: null, manifest: 'rows:2' }); // legacy column stays NULL for older code
    await env.DB.prepare("UPDATE uploads SET manifest = 'pending' WHERE id = ?").bind(up.upload_id).run();
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    const res = await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe('upload_busy');
  });

  it('fails the commit when manifest rows were lost instead of treating it as no manifest', async () => {
    const { env } = await import('cloudflare:workers');
    const up = await begin(['index.html', 'a.css']);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    await env.DB.prepare('DELETE FROM upload_expected WHERE upload_id = ?').bind(up.upload_id).run();
    const res = await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe('manifest_lost');
  });

  it('the cleanup sweep keeps manifest rows of live sessions', async () => {
    const { env } = await import('cloudflare:workers');
    const { runCleanup } = await import('../src/cron');
    const up = await begin(['index.html', 'a.css']);
    await env.DB.prepare("INSERT INTO upload_expected (upload_id, path) VALUES ('gone-session', 'x.html')").run();
    await runCleanup(env as any);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id = ?').bind(up.upload_id).first<any>()).n).toBe(2);
    expect(await env.DB.prepare("SELECT 1 FROM upload_expected WHERE upload_id = 'gone-session'").first()).toBeNull();
  });
});

describe('review regressions (loop 2, round 4)', () => {
  it('rejects paths that are not well-formed Unicode', async () => {
    const res = await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['a\uD800.txt', 'a\uD801.txt'] }) });
    expect(res.status).toBe(400);
    expect((await res.json<any>()).error.code).toBe('invalid_path');
    const ok = await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['emoji-\uD83D\uDE00.txt'] }) });
    expect(ok.status).toBe(201); // a proper surrogate pair is fine
    await ok.arrayBuffer();
  });

  it('still completes an abort when removing the manifest rows fails', async () => {
    const { env } = await import('cloudflare:workers');
    const { abortUpload } = await import('../src/lib/store');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    const db = new Proxy(env.DB, {
      get: (t, p) =>
        p === 'prepare'
          ? (sql: string) => (sql.startsWith('DELETE FROM upload_expected') ? { bind: () => ({ run: () => Promise.reject(new Error('D1 hiccup')) }) } : (t as any).prepare(sql))
          : typeof (t as any)[p] === 'function'
            ? (t as any)[p].bind(t)
            : (t as any)[p],
    });
    await abortUpload({ ...(env as any), DB: db }, row); // must not throw
    expect(await env.BUCKET.head(`a/${up.artifact_id}/v${up.version}/index.html`)).toBeNull(); // files purged
  });
});

describe('review regressions (loop 2, round 5)', () => {
  it('stores a large manifest with only a few statements', async () => {
    const { env } = await import('cloudflare:workers');
    await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_version_files: 10000 }) }), 200);
    const prepares: string[] = [];
    const db = new Proxy(env.DB, {
      get: (t, p) => (p === 'prepare' ? (sql: string) => (prepares.push(sql), (t as any).prepare(sql)) : typeof (t as any)[p] === 'function' ? (t as any)[p].bind(t) : (t as any)[p]),
    });
    try {
      const { beginUpload } = await import('../src/lib/store');
      const files = Array.from({ length: 10000 }, (_, i) => `dir-${'y'.repeat(300)}/f-${i}.css`);
      const up = await beginUpload({ ...(env as any), DB: db }, { meta: {}, expected: files, createdBy: 'test' });
      expect(up.manifest).toBe('rows:10000');
      expect(prepares.filter((s) => s.startsWith('INSERT OR IGNORE INTO upload_expected')).length).toBeLessThan(15);
    } finally {
      await json(await api('/api/settings', { method: 'PATCH', auth: 'session', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max_version_files: 2000 }) }), 200);
    }
  });
});

describe('review regressions (loop 2, round 7)', () => {
  it('a commit that races a finished commit reports upload_closed, not a lost manifest', async () => {
    const { env } = await import('cloudflare:workers');
    const { commitUpload } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    const stale = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>(); // B read the session…
    await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 201); // …then A committed it
    await expect(commitUpload(env as any, stale, await getSettings(env as any))).rejects.toMatchObject({ code: 'upload_closed' });
  });

  it('a commit that races an abort reports upload_not_found, not missing files', async () => {
    const { env } = await import('cloudflare:workers');
    const { commitUpload } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    const stale = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    expect((await api(`/api/v1/uploads/${up.upload_id}`, { method: 'DELETE' })).status).toBe(204);
    await expect(commitUpload(env as any, stale, await getSettings(env as any))).rejects.toMatchObject({ code: 'upload_not_found' });
  });
});

describe('manifest cleanup follow-ups', () => {
  const jsonHeaders = { 'content-type': 'application/json' };

  it('sweeps orphan manifest rows in bounded batches and keeps live sessions', async () => {
    const { env } = await import('cloudflare:workers');
    const { sweepOrphanManifests } = await import('../src/cron');
    const live = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ files: ['a.html', 'b.html'] }) }), 201);
    const values = Array.from({ length: 7 }, (_, i) => `('orphan-sweep', 'f${i}.html')`).join(', ');
    await env.DB.prepare(`INSERT INTO upload_expected (upload_id, path) VALUES ${values}`).run();

    // other tests may leave orphans too (shared DB), so assert on capped counts and on our own rows
    expect(await sweepOrphanManifests(env as any, 2, 2)).toBe(4); // capped: 2 batches of 2
    await sweepOrphanManifests(env as any, 2, 50); // later runs work off the rest of the backlog
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id = 'orphan-sweep'").first<any>()).n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id = ?').bind(live.upload_id).first<any>()).n).toBe(2);
  });

  it('does not hand out a session that was removed while its file list was written', async () => {
    const { env } = await import('cloudflare:workers');
    const { beginUpload } = await import('../src/lib/store');
    let removed = false;
    // simulate the session vanishing (e.g. its artifact purged) right before its manifest is marked complete
    const db = new Proxy(env.DB, {
      get: (t, p) => {
        if (p === 'prepare') {
          return (sql: string) => {
            const stmt = (t as any).prepare(sql);
            if (!sql.startsWith('UPDATE uploads SET manifest')) return stmt;
            return {
              bind: (...args: any[]) => ({
                run: async () => {
                  await (t as any).prepare('DELETE FROM uploads WHERE id = ?').bind(args[1]).run();
                  removed = true;
                  return stmt.bind(...args).run();
                },
              }),
            };
          };
        }
        return typeof (t as any)[p] === 'function' ? (t as any)[p].bind(t) : (t as any)[p];
      },
    });
    const err = await beginUpload({ ...(env as any), DB: db }, { meta: {}, expected: ['index.html', 'a.css'], createdBy: 'test' }).catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: 'not_found' }); // the artifact went away; no upload ID was handed out
    expect(removed).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_expected WHERE upload_id NOT IN (SELECT id FROM uploads)").first<any>()).n).toBe(0);
  });
});

describe('retried commits', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const start = async () => {
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    return up;
  };

  it('answers a commit retried after success with 409 upload_closed, not 404', async () => {
    const up = await start();
    await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 201);
    const retry = await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }); // first response "lost"
    expect(retry.status).toBe(409);
    expect((await retry.json<any>()).error.code).toBe('upload_closed');
  });

  it('still answers 404 for a commit of an aborted session', async () => {
    const up = await start();
    expect((await api(`/api/v1/uploads/${up.upload_id}`, { method: 'DELETE' })).status).toBe(204);
    const res = await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect((await res.json<any>()).error.code).toBe('upload_not_found');
  });
});

describe('committed sessions answer upload_closed everywhere', () => {
  const jsonHeaders = { 'content-type': 'application/json' };
  const publish = async (artifactId?: string, body = '<p>i</p>') => {
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ artifact_id: artifactId, files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body }), 200);
    const res = await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' });
    expect([200, 201]).toContain(res.status);
    await res.arrayBuffer();
    return up;
  };
  const codeOf = async (res: Response) => ({ status: res.status, code: (await res.json<any>()).error.code });

  it('for a retried file PUT or DELETE after the commit', async () => {
    const up = await publish();
    expect(await codeOf(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: 'x' }))).toEqual({ status: 409, code: 'upload_closed' });
    expect(await codeOf(await api(`/api/v1/uploads/${up.upload_id}`, { method: 'DELETE' }))).toEqual({ status: 409, code: 'upload_closed' });
  });

  it('for a session begun before migration 0003 (no upload_id on its version)', async () => {
    const { env } = await import('cloudflare:workers');
    const { commitUpload } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    const stale = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>();
    await env.DB.prepare('UPDATE artifact_versions SET upload_id = NULL WHERE artifact_id = ?').bind(up.artifact_id).run(); // as old code wrote it
    await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 201);
    await expect(commitUpload(env as any, stale, await getSettings(env as any))).rejects.toMatchObject({ code: 'upload_closed' });
  });

  it('after the committed version has been retired by cleanup', async () => {
    const { env } = await import('cloudflare:workers');
    const { retireVersion } = await import('../src/lib/store');
    const first = await publish();
    await publish(first.artifact_id, '<p>v2</p>'); // v1 is no longer live
    expect(await retireVersion(env as any, first.artifact_id, first.version)).toBe(true);
    expect(await codeOf(await api(`/api/v1/uploads/${first.upload_id}/commit`, { method: 'POST' }))).toEqual({ status: 409, code: 'upload_closed' });
  });
});

describe('file writes on a session that just closed', () => {
  it('answers 404 (not upload_closed) when the session was aborted mid-write', async () => {
    const { env } = await import('cloudflare:workers');
    const { putUploadFile } = await import('../src/lib/store');
    const { getSettings } = await import('../src/lib/settings');
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    const row = await env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(up.upload_id).first<any>(); // PUT passed requireUpload…
    expect((await api(`/api/v1/uploads/${up.upload_id}`, { method: 'DELETE' })).status).toBe(204); // …then an abort landed
    await expect(putUploadFile(env as any, row, 'index.html', '<p>i</p>', await getSettings(env as any))).rejects.toMatchObject({ status: 404, code: 'upload_not_found' });
  });
});

describe('error codes for deleted artifacts', () => {
  it('answers a retried commit with 404 once the artifact is deleted', async () => {
    const up = await json(await api('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['index.html'] }) }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/index.html`, { method: 'PUT', body: '<p>i</p>' }), 200);
    await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 201);
    expect((await api(`/api/v1/artifacts/${up.artifact_id}`, { method: 'DELETE' })).status).toBe(204);
    const retry = await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' });
    expect(retry.status).toBe(404); // consistent with GET /artifacts/{id}
    expect((await retry.json<any>()).error.code).toBe('upload_not_found');
  });
});

describe('Markdown shares', () => {
  const notes = '# Notes\n\n```js\nconst value = 42;\n```\n';
  /** A browser page load; anything else (curl, fetch) gets the raw file. */
  const page = (url: string, cookie?: string) => fetchRaw(url, { headers: { 'sec-fetch-dest': 'document', ...(cookie ? { cookie } : {}) } });

  it('serves the Markdown reader by default and downloads the exact source', async () => {
    const a = await json(await api('/api/v1/artifacts?visibility=public&filename=Notes.markdown', {
      method: 'POST', headers: { 'content-type': 'text/markdown' }, body: notes,
    }), 201);
    expect(a).toMatchObject({ kind: 'markdown', entry: 'Notes.markdown' });

    const preview = await page(a.content_url);
    expect(preview.headers.get('content-type')).toContain('text/html');
    expect(preview.headers.get('content-security-policy')).toContain("default-src 'none'");
    const previewHtml = await preview.text();
    expect(previewHtml).toMatch(/\/__share\/markdown\/preview-[A-Za-z0-9_-]+\.js/);
    expect(previewHtml).toMatch(/\/__share\/markdown\/preview-[A-Za-z0-9_-]+\.css/);

    const raw = await fetchRaw(`${a.content_url}?__share_raw=1`);
    expect(raw.headers.get('content-type')).toContain('text/markdown');
    expect(await raw.text()).toBe(notes);
    const again = await page(a.content_url);
    expect(again.headers.get('content-type')).toContain('text/html');
    await again.arrayBuffer();

    const meta = await json(await fetchRaw(`${MAIN}/api/public/artifacts/${a.public_id}`, { headers: { cookie: session } }), 200);
    expect(meta.download).toMatchObject({ kind: 'markdown', name: 'Notes.markdown', file_count: 1 });
    const download = await fetchRaw(`${MAIN}/s/${a.public_id}/download`, { headers: { cookie: session } });
    expect(download.headers.get('content-disposition')).toContain('attachment; filename="Notes.markdown"');
    expect(await download.text()).toBe(notes);
  });

  it('embeds the authorized source as inert data in the reader response', async () => {
    const source = '# Snapshot\r\n\r\n</script><script>example()</script>\n';
    const a = await json(await api('/api/v1/artifacts?visibility=public', {
      method: 'POST', headers: { 'content-type': 'text/markdown' }, body: source,
    }), 201);
    const res = await page(a.content_url);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('vary')).toContain('sec-fetch-dest');
    const preview = await res.text();
    expect(preview).not.toContain('<script>example()');
    const embedded = preview.match(/id="reader:markdown">([^<]+)<\/script>/)?.[1];
    expect(embedded).toBeDefined();
    expect(JSON.parse(embedded!)).toBe(source);

    const asset = await fetchRaw(a.content_url, { headers: { 'sec-fetch-dest': 'empty' } });
    expect(asset.headers.get('content-type')).toContain('text/markdown');
    expect(asset.headers.get('vary')).toContain('sec-fetch-dest');
    expect(await asset.text()).toBe(source);
  });

  it('sends raw Markdown to non-browser clients and renders any Markdown page in a folder', async () => {
    const a = await json(await api('/api/v1/artifacts?visibility=public', {
      method: 'POST', headers: { 'content-type': 'text/markdown' }, body: notes,
    }), 201);
    const curl = await fetchRaw(a.content_url, { headers: { accept: '*/*' } });
    expect(curl.headers.get('content-type')).toContain('text/markdown');
    expect(await curl.text()).toBe(notes);
    for (const accept of ['text/markdown, text/html;q=0.9, */*', 'text/plain, text/html', 'text/html;q=0, */*']) {
      const agent = await fetchRaw(a.content_url, { headers: { accept } });
      expect(agent.headers.get('content-type')).toContain('text/markdown');
      expect(await agent.text()).toBe(notes);
    }
    const legacy = await fetchRaw(a.content_url, { headers: { accept: 'text/html,*/*;q=0.8' } });
    expect(legacy.headers.get('content-type')).toContain('text/html');
    await legacy.arrayBuffer();

    const form = new FormData();
    form.append('file', new File([notes], 'README.md'));
    form.append('file', new File(['# Guide\n'], 'docs/guide.md'));
    const f = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    expect(f.entry).toBe('README.md');
    const guide = await page(`${f.content_url}docs/guide.md`);
    expect(guide.headers.get('content-type')).toContain('text/html');
    expect(await guide.text()).toContain('id="reader:markdown"');
    const guideRaw = await fetchRaw(`${f.content_url}docs/guide.md`);
    expect(await guideRaw.text()).toBe('# Guide\n');
  });

  it('revalidates reader pages and bundle assets with a 304', async () => {
    const a = await json(await api('/api/v1/artifacts?visibility=public', {
      method: 'POST', headers: { 'content-type': 'text/markdown' }, body: notes,
    }), 201);
    const first = await page(a.content_url);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"md-/);
    await first.arrayBuffer();
    const again = await fetchRaw(a.content_url, { headers: { 'sec-fetch-dest': 'document', 'if-none-match': etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get('content-security-policy')).toContain("default-src 'none'");
    const other = await fetchRaw(a.content_url, { headers: { 'sec-fetch-dest': 'document', 'accept-language': etag!.includes('-zh-') ? 'en' : 'zh-CN', 'if-none-match': etag! } });
    expect(other.status).toBe(200); // the language is part of the validator
    await other.arrayBuffer();

    const js = await fetchRaw(`${a.content_url}__share/markdown/preview.js`);
    const jsTag = js.headers.get('etag');
    const bundle = await js.text();
    expect(jsTag).toBeTruthy();
    const cached = await fetchRaw(`${a.content_url}__share/markdown/preview.js`, { headers: { 'if-none-match': jsTag! } });
    expect(cached.status).toBe(304);
    const chunkPath = bundle.match(/import\("\.\/(chunks\/[^"]+\.js)"\)/)?.[1];
    const chunk = await fetchRaw(`${a.content_url}__share/markdown/${chunkPath}`);
    expect(chunk.headers.get('cache-control')).toContain('immutable');
    await chunk.arrayBuffer();
  });

  it('opens index.md or README.md for a directory URL in a Markdown folder', async () => {
    const form = new FormData();
    form.append('file', new File([notes], 'README.md'));
    form.append('file', new File(['# Guide\n'], 'guide/index.md'));
    form.append('file', new File(['# Ref\n'], 'ref/Readme.md'));
    form.append('file', new File(['# Docs\n'], 'Über 📚/README.md'));
    form.append('file', new File(['# Deep\n'], 'guide/sub/index.md'));
    form.append('file', new File(['# V\n'], 'v1.2/README.md'));
    form.append('file', new File(['# Md\n'], 'md/README.md'));
    const f = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    for (const [path, location] of [['guide/', '/guide/index.md'], ['guide', '/guide/index.md'], ['guide//', '/guide/index.md'], ['v1.2', '/v1.2/README.md'], ['md', '/md/README.md'], ['ref/?x=1', '/ref/Readme.md?x=1'], ['%C3%9Cber%20%F0%9F%93%9A/', '/%C3%9Cber%20%F0%9F%93%9A/README.md']]) {
      const res = await page(`${f.content_url}${path}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(location);
    }
    const missing = await page(`${f.content_url}nope/`);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();

    // An HTML SPA keeps its client-side routes even when the build ships a docs/README.md.
    const spa = new FormData();
    spa.append('file', new File(['<h1>App</h1>'], 'index.html'));
    spa.append('file', new File([notes], 'docs/README.md'));
    const app = await json(await api('/api/v1/artifacts?visibility=public&spa_fallback=true', { method: 'POST', body: spa }), 201);
    const route = await page(`${app.content_url}docs`);
    expect(route.status).toBe(200);
    expect(await route.text()).toBe('<h1>App</h1>');
  });

  it.each([
    [['index.markdown', 'index.md', 'README.md'], 'index.md'],
    [['README.markdown', 'README.md'], 'README.md'],
    [['README.md', 'INDEX.MARKDOWN'], 'INDEX.MARKDOWN'],
  ])('uses the same Markdown index priority at the root and in subfolders (%j)', async (names, expected) => {
    const form = new FormData();
    for (const name of names) form.append('file', new File([notes], name));
    for (const name of [...names].reverse()) form.append('file', new File([notes], `guide/${name}`));
    const artifact = await json(await api('/api/v1/artifacts?visibility=public', { method: 'POST', body: form }), 201);
    expect(artifact.entry).toBe(expected);
    const directory = await page(`${artifact.content_url}guide/`);
    expect(directory.status).toBe(302);
    expect(directory.headers.get('location')).toBe(`/guide/${expected}`);
  });

  it('offers large Markdown as plain source without buffering it into the reader', async () => {
    const { MARKDOWN_PREVIEW_MAX_BYTES } = await import('../src/content/markdown');
    const source = 'x'.repeat(MARKDOWN_PREVIEW_MAX_BYTES + 1);
    const a = await json(await api('/api/v1/artifacts?visibility=public', {
      method: 'POST', headers: { 'content-type': 'text/markdown' }, body: source,
    }), 201);
    const res = await page(a.content_url);
    const shell = await res.text();
    expect(shell).toContain('?__share_raw=plain');
    expect(shell).not.toContain('id="reader:markdown"');

    const plain = await fetchRaw(`${a.content_url}?__share_raw=plain`);
    expect(plain.headers.get('content-type')).toContain('text/plain');
    expect(await plain.text()).toBe(source);
    const raw = await fetchRaw(`${a.content_url}?__share_raw=1`);
    expect(raw.headers.get('content-type')).toContain('text/markdown');
    await raw.arrayBuffer();
  });

  it('redirects Markdown SPA fallback to the entry so relative paths stay valid', async () => {
    const form = new FormData();
    form.append('file', new File([notes], 'docs/start.md'));
    form.append('file', new File(['<svg/>'], 'docs/mark.svg'));
    form.append('file', new File(['other'], 'other.txt'));
    const a = await json(await api('/api/v1/artifacts?visibility=public&spa_fallback=true', { method: 'POST', body: form }), 201);
    const fallback = await fetchRaw(`${a.content_url}nested/missing?x=1`);
    expect(fallback.status).toBe(302);
    expect(fallback.headers.get('location')).toBe('/docs/start.md?x=1');
    const preview = await page(new URL(fallback.headers.get('location')!, a.content_url).href);
    expect(await preview.text()).toContain('id="reader:markdown"');
  });

  it('applies access-code protection to the reader and raw source in a nested folder', async () => {
    const form = new FormData();
    form.append('file', new File([notes], 'docs/start.md'));
    form.append('file', new File(['<svg/>'], 'docs/mark.svg'));
    form.append('file', new File(['<h1>Home</h1>'], 'index.html'));
    const a = await json(await api('/api/v1/artifacts?visibility=password&entry=docs/start.md', {
      method: 'POST', body: form,
    }), 201);
    expect(a).toMatchObject({ kind: 'folder', entry: 'docs/start.md' });
    for (const suffix of ['', '?__share_raw=1']) {
      const denied = await fetchRaw(`${a.content_url}docs/start.md${suffix}`);
      expect(denied.status).toBe(401);
      await denied.arrayBuffer();
    }

    const unlock = await fetchRaw(`${a.content_url}?pwd=${a.password}`);
    const cookie = cookieFrom(unlock, 'as_unlock');
    const root = await fetchRaw(a.content_url, { headers: { cookie } });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/docs/start.md');
    const preview = await page(`${a.content_url}docs/start.md`, cookie);
    expect(await preview.text()).toContain('aria-controls="reader:source"');
    const source = await fetchRaw(`${a.content_url}docs/start.md?__share_raw=1`, { headers: { cookie } });
    expect(await source.text()).toBe(notes);
    const image = await fetchRaw(`${a.content_url}docs/mark.svg`, { headers: { cookie } });
    expect(await image.text()).toBe('<svg/>');
  });

  it.each([['guide.md', notes], ['index.html', '<h1>HTML</h1>']])('downloads a folder containing only %s as a ZIP', async (filename, body) => {
    const up = await json(await api('/api/v1/uploads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [filename], source_kind: 'folder' }),
    }), 201);
    await json(await api(`/api/v1/uploads/${up.upload_id}/files/${filename}`, { method: 'PUT', body }), 200);
    const a = await json(await api(`/api/v1/uploads/${up.upload_id}/commit`, { method: 'POST' }), 201);
    expect(a.kind).toBe('folder');
    const download = await fetchRaw(`${MAIN}/s/${a.public_id}/download`, { headers: { cookie: session } });
    expect(download.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    expect(Object.keys(files)).toEqual([filename]);
    expect(strFromU8(files[filename])).toBe(body);
  });

  it('infers a Markdown folder entry and serves the reader assets on the content host', async () => {
    const form = new FormData();
    form.append('file', new File([notes], 'README.md'));
    form.append('file', new File(['image'], 'figure.svg'));
    const a = await json(await api('/api/v1/artifacts', { method: 'POST', body: form }), 201);
    expect(a).toMatchObject({ kind: 'folder', entry: 'README.md' });
    const js = await fetchRaw(`${a.content_url}__share/markdown/preview.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    const bundle = await js.text();
    const mermaid = bundle.match(/import\("\.\/(chunks\/mermaid[^"]+\.js)"\)/)?.[1];
    expect(mermaid).toBeDefined();
    const chunk = await fetchRaw(`${a.content_url}__share/markdown/${mermaid}`);
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get('content-type')).toContain('javascript');
    await chunk.arrayBuffer();
    const missing = await fetchRaw(`${a.content_url}__share/markdown/chunks/unknown.js`);
    expect(missing.status).toBe(404);
  });
});
