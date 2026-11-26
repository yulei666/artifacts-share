import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ArtifactRow, Env } from '../src/env';
import worker from '../src/index';
import { HttpError } from '../src/lib/http';
import { invalidateSettingsCache } from '../src/lib/settings';
import { getArtifactByPublicId, patchArtifact, regenerateLink, softDeleteArtifact } from '../src/lib/store';

const MAIN = 'https://share.example.com';
const ORIGIN = { origin: MAIN };
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

/** Wraps a D1Database to record SQL statements and optionally hook statement execution. */
function spyDb(
  base: D1Database,
  onPrepare?: (sql: string, stmt: D1PreparedStatement) => D1PreparedStatement,
): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const db = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          queries.push(sql);
          const stmt = target.prepare(sql);
          return onPrepare ? onPrepare(sql, stmt) : stmt;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, queries };
}

/** Wraps a D1PreparedStatement so `.first()` runs through a hook. */
function interceptFirst(stmt: D1PreparedStatement, hook: (run: () => Promise<unknown>) => Promise<unknown>): D1PreparedStatement {
  const wrapStmt = (targetStmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(targetStmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') {
          return (...args: unknown[]) => wrapStmt(target.bind(...args));
        }
        if (prop === 'first') {
          return (col?: string) => hook(() => (col === undefined ? target.first() : target.first(col)));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return wrapStmt(stmt);
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

async function createHtml(html: string, query = ''): Promise<any> {
  return json(await api(`/api/v1/artifacts${query}`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: html }), 201);
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
      body: JSON.stringify({ name: 'gateway-perf' }),
    }),
    201,
  );
  token = t.token;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('content gateway hot path (Plan 1.2)', () => {
  it('writes public content to caches.default with max-age=86400 while preserving browser must-revalidate', async () => {
    const a = await createHtml('<h1>Cached</h1>', '?visibility=public&title=Cached');
    const putSpy = vi.spyOn(caches.default, 'put');

    const { res, flush } = await callWorker(env as unknown as Env, a.content_url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(await res.text()).toBe('<h1>Cached</h1>');
    await flush();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const [cacheKey, cachedResponse] = putSpy.mock.calls[0];
    expect((cacheKey as Request).url).toContain(`/__cache/v${a.current_version}/i0/index.html`);
    expect((cachedResponse as Response).headers.get('cache-control')).toBe('public, max-age=86400');

    // Second request hits edge cache and still sends PUBLIC_BROWSER_CACHE to the browser.
    const hit = await callWorker(env as unknown as Env, a.content_url);
    expect(hit.res.status).toBe(200);
    expect(hit.res.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(await hit.res.text()).toBe('<h1>Cached</h1>');
    await hit.flush();
  });

  it('runs getArtifactByPublicId and isOwner in parallel when __Host-as_owner cookie is present, and skips session DB work without it', async () => {
    const priv = await createHtml('<h1>Secret</h1>', '?visibility=private&title=Secret');
    const pub = await createHtml('<h1>Open</h1>', '?visibility=public&title=Open');

    // Obtain a real __Host-as_owner cookie via /handoff -> /__share/auth.
    const handoff = await api(`/handoff?id=${priv.public_id}&next=%2F`, { auth: 'session' });
    expect(handoff.status).toBe(302);
    const authRes = await callWorker(env as unknown as Env, handoff.headers.get('location')!);
    await authRes.flush();
    expect(authRes.res.status).toBe(302);
    const ownerCookie = cookieFrom(authRes.res, 'as_owner');

    // 1. With __Host-as_owner cookie: hold the artifacts query open until the sessions query ALSO starts.
    //    If they ran sequentially, the sessions query would never begin and this would time out.
    let releaseArtifact!: () => void;
    const artifactGate = new Promise<void>((r) => { releaseArtifact = r; });
    let artifactStarted = false;
    let sessionStartedWhileArtifactPending = false;

    const { db: parallelDb } = spyDb((env as unknown as Env).DB, (sql, stmt) => {
      if (sql.includes('FROM artifacts WHERE public_id')) {
        return interceptFirst(stmt, async (run) => {
          artifactStarted = true;
          await artifactGate;
          return run();
        });
      }
      if (sql.includes('FROM sessions WHERE id')) {
        return interceptFirst(stmt, async (run) => {
          if (artifactStarted) sessionStartedWhileArtifactPending = true;
          releaseArtifact();
          return run();
        });
      }
      return stmt;
    });

    const parallelEnv: Env = { ...(env as unknown as Env), DB: parallelDb };
    const ownerReq = await callWorker(parallelEnv, priv.content_url, { headers: { cookie: ownerCookie } });
    expect(ownerReq.res.status).toBe(200);
    expect(await ownerReq.res.text()).toBe('<h1>Secret</h1>');
    await ownerReq.flush();
    expect(sessionStartedWhileArtifactPending).toBe(true);

    // 2. Without __Host-as_owner cookie: private returns 404, public returns 200, and ZERO session queries run.
    const { db: anonDb, queries: anonQueries } = spyDb((env as unknown as Env).DB);
    const anonEnv: Env = { ...(env as unknown as Env), DB: anonDb };

    const privMiss = await callWorker(anonEnv, priv.content_url);
    expect(privMiss.res.status).toBe(404);
    await privMiss.res.arrayBuffer();
    await privMiss.flush();

    const pubHit = await callWorker(anonEnv, pub.content_url);
    expect(pubHit.res.status).toBe(200);
    expect(await pubHit.res.text()).toBe('<h1>Open</h1>');
    await pubHit.flush();

    expect(anonQueries.some((sql) => sql.includes('FROM sessions'))).toBe(false);

    // 3. Nonexistent artifact with an owner cookie still returns 404.
    const missingId = crypto.randomUUID();
    const missingRes = await callWorker(env as unknown as Env, `${content(missingId)}/`, { headers: { cookie: ownerCookie } });
    expect(missingRes.res.status).toBe(404);
    await missingRes.res.arrayBuffer();
    await missingRes.flush();
  });

  it('coalesces concurrent in-flight getArtifactByPublicId calls per DB and removes entry in finally (0ms revocation delay)', async () => {
    const a = await createHtml('<h1>Coalesce</h1>', '?visibility=public&title=Coalesce');

    let release!: () => void;
    let holdNext = true;
    const gate = new Promise<void>((r) => { release = r; });
    let lookupCount = 0;

    const { db } = spyDb((env as unknown as Env).DB, (sql, stmt) => {
      if (!sql.includes('FROM artifacts WHERE public_id')) return stmt;
      return interceptFirst(stmt, async (run) => {
        lookupCount++;
        if (holdNext) {
          holdNext = false;
          await gate;
        }
        return run();
      });
    });
    const testEnv: Env = { ...(env as unknown as Env), DB: db };

    // Launch 3 concurrent lookups for the same public_id -> only 1 D1 query should execute.
    const p1 = getArtifactByPublicId(testEnv, a.public_id);
    const p2 = getArtifactByPublicId(testEnv, a.public_id);
    const p3 = getArtifactByPublicId(testEnv, a.public_id);
    expect(lookupCount).toBe(1);

    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1?.id).toBe(a.id);
    expect(r2?.id).toBe(a.id);
    expect(r3?.id).toBe(a.id);
    expect(lookupCount).toBe(1);

    // After settle, the next call MUST hit D1 freshly (no TTL cache).
    const afterSettle = await getArtifactByPublicId(testEnv, a.public_id);
    expect(afterSettle?.id).toBe(a.id);
    expect(lookupCount).toBe(2);

    // Visibility revocation takes effect immediately on the next lookup.
    await json(
      await api(`/api/v1/artifacts/${a.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: 'private' }),
      }),
      200,
    );
    const afterRevoke = await getArtifactByPublicId(testEnv, a.public_id);
    expect(afterRevoke?.visibility).toBe('private');
    expect(lookupCount).toBe(3);

    // Rejected query cleans up in finally so the next call retries freshly.
    let failFirst = true;
    let errorAttempts = 0;
    const { db: flakyDb } = spyDb((env as unknown as Env).DB, (sql, stmt) => {
      if (!sql.includes('FROM artifacts WHERE public_id')) return stmt;
      return interceptFirst(stmt, async (run) => {
        errorAttempts++;
        if (failFirst) {
          failFirst = false;
          throw new Error('transient d1 error');
        }
        return run();
      });
    });
    const flakyEnv: Env = { ...(env as unknown as Env), DB: flakyDb };
    await expect(getArtifactByPublicId(flakyEnv, a.public_id)).rejects.toThrow('transient d1 error');
    const recovered = await getArtifactByPublicId(flakyEnv, a.public_id);
    expect(recovered?.id).toBe(a.id);
    expect(errorAttempts).toBe(2);
  });
});

describe('admin API & store D1 query tightening (Plan 1.3.1)', () => {
  it('GET /api/v1/artifacts/:id returns joined file_count and total_size in a single D1 query', async () => {
    const form = new FormData();
    form.append('file', new File(['<h1>Home</h1>'], 'index.html', { type: 'text/html' }));
    form.append('file', new File(['body{color:red}'], 'style.css', { type: 'text/css' }));
    const created = await json(await api('/api/v1/artifacts?title=Joined', { method: 'POST', body: form }), 201);

    const { db, queries } = spyDb((env as unknown as Env).DB);
    const testEnv: Env = { ...(env as unknown as Env), DB: db };
    const detail = await json(await api(`/api/v1/artifacts/${created.id}`, { testEnv }), 200);

    expect(detail.id).toBe(created.id);
    expect(detail.file_count).toBe(2);
    expect(detail.total_size).toBe('<h1>Home</h1>'.length + 'body{color:red}'.length);

    const artifactQueries = queries.filter((sql) => sql.includes('artifacts') || sql.includes('artifact_versions'));
    expect(artifactQueries).toHaveLength(1);
    expect(artifactQueries[0]).toMatch(/LEFT JOIN artifact_versions/i);

    // Nonexistent UUID returns 404 not_found.
    const miss = await api(`/api/v1/artifacts/${crypto.randomUUID()}`, { testEnv });
    expect(miss.status).toBe(404);
    expect((await json(miss, 404)).error.code).toBe('not_found');
  });

  it('patchArtifact uses UPDATE ... RETURNING * and preserves not_found, not_password_protected, and invalid_entry errors', async () => {
    const form = new FormData();
    form.append('file', new File(['<h1>A</h1>'], 'index.html', { type: 'text/html' }));
    form.append('file', new File(['<h1>B</h1>'], 'other.html', { type: 'text/html' }));
    const created = await json(await api('/api/v1/artifacts?visibility=public&title=PatchTest', { method: 'POST', body: form }), 201);

    const baseEnv = env as unknown as Env;
    const row = (await baseEnv.DB.prepare('SELECT * FROM artifacts WHERE id = ?').bind(created.id).first<ArtifactRow>())!;

    // 1. Success path: single UPDATE ... RETURNING * query, no trailing SELECT.
    const { db: patchDb, queries: patchQueries } = spyDb(baseEnv.DB);
    const patched = await patchArtifact({ ...baseEnv, DB: patchDb }, row, { title: 'Renamed', visibility: 'password', entry: 'other.html', spa_fallback: true });
    expect(patched.title).toBe('Renamed');
    expect(patched.visibility).toBe('password');
    expect(patched.entry).toBe('other.html');
    expect(patched.spa_fallback).toBe(1);
    expect(patched.password_ver).toBe(row.password_ver + 1);
    expect(patched.password_enc).toBeTruthy();
    expect(patchQueries).toHaveLength(1);
    expect(patchQueries[0]).toMatch(/UPDATE artifacts SET .* RETURNING \*/i);

    // 2. Password reset success in 1 query.
    const { db: resetDb, queries: resetQueries } = spyDb(baseEnv.DB);
    const reset = await patchArtifact({ ...baseEnv, DB: resetDb }, patched, {}, { resetPassword: true });
    expect(reset.password_ver).toBe(patched.password_ver + 1);
    expect(reset.password_enc).not.toBe(patched.password_enc);
    expect(resetQueries).toHaveLength(1);

    // 3. invalid_entry error.
    await expect(patchArtifact(baseEnv, reset, { entry: 'missing.html' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_entry',
    });

    // 4. not_password_protected error when resetting on non-password artifact.
    const pubRow = await patchArtifact(baseEnv, reset, { visibility: 'public' });
    await expect(patchArtifact(baseEnv, pubRow, {}, { resetPassword: true })).rejects.toMatchObject({
      status: 400,
      code: 'not_password_protected',
    });

    // 5. not_found error when artifact is soft-deleted.
    await softDeleteArtifact(baseEnv, pubRow.id);
    await expect(patchArtifact(baseEnv, pubRow, { title: 'Ghost' })).rejects.toBeInstanceOf(HttpError);
    await expect(patchArtifact(baseEnv, pubRow, { title: 'Ghost' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('regenerateLink uses UPDATE ... RETURNING * and preserves not_found and not_password_protected errors', async () => {
    const created = await createHtml('<h1>Regen</h1>', '?visibility=password&title=Regen');
    const baseEnv = env as unknown as Env;
    const row = (await baseEnv.DB.prepare('SELECT * FROM artifacts WHERE id = ?').bind(created.id).first<ArtifactRow>())!;

    // 1. Regenerate link only (1 D1 query).
    const { db: regenDb, queries: regenQueries } = spyDb(baseEnv.DB);
    const regen1 = await regenerateLink({ ...baseEnv, DB: regenDb }, row);
    expect(regen1.public_id).not.toBe(row.public_id);
    expect(regen1.password_ver).toBe(row.password_ver);
    expect(regenQueries).toHaveLength(1);
    expect(regenQueries[0]).toMatch(/UPDATE artifacts SET .* RETURNING \*/i);

    // 2. Regenerate link + resetPassword on password artifact (1 D1 query).
    const { db: regenPwdDb, queries: regenPwdQueries } = spyDb(baseEnv.DB);
    const regen2 = await regenerateLink({ ...baseEnv, DB: regenPwdDb }, regen1, { resetPassword: true });
    expect(regen2.public_id).not.toBe(regen1.public_id);
    expect(regen2.password_ver).toBe(regen1.password_ver + 1);
    expect(regen2.password_enc).not.toBe(regen1.password_enc);
    expect(regenPwdQueries).toHaveLength(1);

    // 3. not_password_protected on non-password artifact.
    const pubRow = await patchArtifact(baseEnv, regen2, { visibility: 'public' });
    await expect(regenerateLink(baseEnv, pubRow, { resetPassword: true })).rejects.toMatchObject({
      status: 400,
      code: 'not_password_protected',
    });

    // 4. not_found on soft-deleted artifact (both with and without resetPassword).
    await softDeleteArtifact(baseEnv, pubRow.id);
    await expect(regenerateLink(baseEnv, pubRow)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(regenerateLink(baseEnv, pubRow, { resetPassword: true })).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('POST /api/v1/artifacts/:id/versions/:v/activate uses UPDATE ... RETURNING * and preserves version_not_found', async () => {
    const v1 = await createHtml('<h1>V1</h1>', '?visibility=public&title=Versions');
    const v2 = await json(
      await api(`/api/v1/artifacts/${v1.id}/content`, {
        method: 'PUT',
        headers: { 'content-type': 'text/html' },
        body: '<h1>V2</h1>',
      }),
      200,
    );
    expect(v2.current_version).toBe(2);

    const { db, queries } = spyDb((env as unknown as Env).DB);
    const testEnv: Env = { ...(env as unknown as Env), DB: db };

    const activated = await json(await api(`/api/v1/artifacts/${v1.id}/versions/1/activate`, { method: 'POST', testEnv }), 200);
    expect(activated.current_version).toBe(1);

    const updateIdx = queries.findIndex((sql) => /UPDATE artifacts SET current_version/i.test(sql));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(queries[updateIdx]).toMatch(/RETURNING \*/i);
    // No trailing SELECT * FROM artifacts after the UPDATE.
    expect(queries.slice(updateIdx + 1).some((sql) => /SELECT \* FROM artifacts/i.test(sql))).toBe(false);

    // Nonexistent version returns 404 version_not_found.
    const badNum = await api(`/api/v1/artifacts/${v1.id}/versions/99/activate`, { method: 'POST', testEnv });
    expect((await json(badNum, 404)).error.code).toBe('version_not_found');

    const badStr = await api(`/api/v1/artifacts/${v1.id}/versions/nope/activate`, { method: 'POST', testEnv });
    expect((await json(badStr, 404)).error.code).toBe('version_not_found');
  });
});

describe('per-file upload settings cache (Plan 1.5.1)', () => {
  it('uses cached settings across PUT /uploads/:uid/files/* while keeping fresh reads on POST /uploads and commit', async () => {
    invalidateSettingsCache();
    const { db, queries } = spyDb((env as unknown as Env).DB);
    const testEnv: Env = { ...(env as unknown as Env), DB: db };
    const countSettingsQueries = () => queries.filter((sql) => sql.includes('FROM settings')).length;

    // Start upload session with files manifest -> POST /uploads reads settings fresh (1).
    const sessionRes = await json(
      await api('/api/v1/uploads', {
        method: 'POST',
        testEnv,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'UploadCache', visibility: 'public', indexable: false, files: ['index.html', 'a.js', 'b.css'] }),
      }),
      201,
    );
    expect(countSettingsQueries()).toBe(1);

    // Upload 3 files -> PUT /uploads/:uid/files/* reuses the 30s settings cache (0 additional settings queries).
    for (const [name, body] of [
      ['index.html', '<h1>Hi</h1>'],
      ['a.js', 'console.log(1);'],
      ['b.css', 'body{}'],
    ] as const) {
      await json(
        await api(`/api/v1/uploads/${sessionRes.upload_id}/files/${name}`, {
          method: 'PUT',
          testEnv,
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) },
          body,
        }),
        200,
      );
    }
    expect(countSettingsQueries()).toBe(1);

    // Commit -> keeps { fresh: true } so settings are queried freshly again (+1).
    const committed = await json(await api(`/api/v1/uploads/${sessionRes.upload_id}/commit`, { method: 'POST', testEnv }), 201);
    expect(committed.id).toBe(sessionRes.artifact_id);
    expect(countSettingsQueries()).toBe(2);

    // Verify cold-cache PUT populates cache once and reuses it on the next PUT.
    invalidateSettingsCache();
    const beforeCold = countSettingsQueries();
    const session2 = await json(
      await api('/api/v1/uploads', {
        method: 'POST',
        testEnv,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'ColdPut', visibility: 'public' }),
      }),
      201,
    );
    expect(countSettingsQueries()).toBe(beforeCold); // no `files` manifest -> settings not read yet

    await json(
      await api(`/api/v1/uploads/${session2.upload_id}/files/index.html`, {
        method: 'PUT',
        testEnv,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '10' },
        body: '<h1>1</h1>',
      }),
      200,
    );
    expect(countSettingsQueries()).toBe(beforeCold + 1);

    await json(
      await api(`/api/v1/uploads/${session2.upload_id}/files/app.js`, {
        method: 'PUT',
        testEnv,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '8' },
        body: 'void 0;\n',
      }),
      200,
    );
    expect(countSettingsQueries()).toBe(beforeCold + 1); // cached!

    await api(`/api/v1/uploads/${session2.upload_id}`, { method: 'DELETE', testEnv });
  });
});
