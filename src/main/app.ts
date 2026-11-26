import { Hono } from 'hono';
import type { ArtifactRow, Env } from '../env';
import { hashPassword, randomBase62, randomToken, sha256Hex, signPayload, timingSafeEqualStr, verifyPassword, verifyPayload } from '../lib/crypto';
import { contentOrigin, isUuid } from '../lib/hosts';
import { clearHostCookie, clientIp, hostCookie, HttpError, jsonError, now, parseCookies, readJsonObject, safeRelativePath } from '../lib/http';
import { peekAttempts } from '../lib/ratelimit';
import { captchaRequired, guardedAttempt, loginBucket, verifyAccessCode } from '../lib/access';
import { analyticsEnabled, recordReferral } from '../lib/analytics';
import { CAPTCHA_AFTER_FAILS, turnstileEnabled } from '../lib/turnstile';
import { getInternal, getSettings, setInternal, updateSettings } from '../lib/settings';
import { artifactView, getArtifact, getArtifactByPublicId, viewerUrl } from '../lib/store';
import type { HandoffTicket, UnlockProof } from '../content/gateway';
import { api } from './api';
import { downloadInfo, registerDownloadRoutes } from './download';
import {
  callbackUrl,
  canLogin,
  getProvider,
  handleCallback,
  isProvider,
  listProviders,
  loginMethods,
  PROVIDER_NAMES,
  saveProvider,
  setBinding,
  startUrl,
  type Provider,
} from './oauth';
import { type AppContext, type AppEnv, authenticate, createSession, destroySession, requireSession, sessionOf } from './session';

/** Admin/viewer CSP; frame-src admits only artifact subdomains (the viewer's iframe). */
function adminCsp(env: Env, ref: URL): string {
  const port = ref.port ? `:${ref.port}` : '';
  const frames = `${ref.protocol}//*.${env.CONTENT_ZONE}${port}`;
  // challenges.cloudflare.com: Turnstile on the login page (script + its iframe).
  const ts = 'https://challenges.cloudflare.com';
  return `default-src 'self'; script-src 'self' ${ts}; style-src 'self'; img-src 'self' data:; connect-src 'self' ${ts}; font-src 'self'; frame-src ${frames} ${ts}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

/** One-time owner sign-in URL on the artifact's subdomain (sets the owner cookie, then goes to `next`). */
async function ownerAuthUrl(env: Env, ref: URL, publicId: string, sessionId: string, next = '/'): Promise<string> {
  const ticket = await signPayload(env.SECRET_KEY, { k: 'handoff', id: publicId, sid: sessionId, exp: now() + 60, n: randomToken(16) } satisfies HandoffTicket);
  const target = new URL(`${contentOrigin(env, publicId, ref)}/__share/auth`);
  target.searchParams.set('ticket', ticket);
  target.searchParams.set('next', next);
  return target.toString();
}

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return jsonError(err.status, err.code, err.message, err.details);
  if (err.message.includes('sign_in_method_required')) return jsonError(400, 'lockout', 'Keep at least one other sign-in method enabled');
  console.error(err);
  return jsonError(500, 'internal_error', 'Internal error');
});

app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('content-security-policy')) h.set('content-security-policy', adminCsp(c.env, new URL(c.req.url)));
  h.set('x-frame-options', 'DENY');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'same-origin');
  if (!h.has('x-robots-tag')) h.set('x-robots-tag', 'noindex, nofollow');
  if (c.req.path.startsWith('/api/') && !h.has('cache-control')) h.set('cache-control', 'no-store');
});

app.use('/api/*', authenticate);
app.use('/handoff', authenticate);
app.use('/s/*', authenticate);

// Only viewer pages may be crawled (and each one still sends noindex unless the artifact allows it).
app.get('/robots.txt', (c) => c.text('User-agent: *\nAllow: /s/\nDisallow: /\n'));

// ---------- share viewer ----------

function isOwner(c: AppContext): boolean {
  const s = sessionOf(c);
  return !!s && s.method !== 'bootstrap';
}

/** Artifact as visible to the caller on the viewer page; null when it must look nonexistent. */
async function viewable(c: AppContext, publicId: string) {
  if (!isUuid(publicId)) return null;
  const a = await getArtifactByPublicId(c.env, publicId);
  if (!a || a.current_version == null) return null;
  const owner = isOwner(c);
  if (a.visibility === 'private' && !owner) return null;
  return { a, owner };
}

// The viewer shell: top bar + sandboxed iframe of the artifact's subdomain (see web/viewer.js).
app.get('/s/:pid/', (c) => c.redirect(`/s/${encodeURIComponent(c.req.param('pid'))}${new URL(c.req.url).search}`, 301));
app.get('/s/:pid', async (c) => {
  const v = await viewable(c, c.req.param('pid'));
  const isGet = c.req.method === 'GET';
  if (v && !v.owner && isGet) recordReferral(c.env, c.executionCtx, c.req.raw, v.a);
  const ref = new URL(c.req.url);
  const shellReq = new Request(new URL('/viewer', ref));
  if (v && isGet) {
    const [shell, payload] = await Promise.all([c.env.ASSETS.fetch(shellReq), viewerInfo(c, v, ref)]);
    const tag = `<script type="application/json" id="viewer-init">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>`;
    const html = (await shell.text()).replace('</head>', () => `${tag}</head>`);
    const headers = new Headers(shell.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('cache-control', 'private, no-store');
    headers.set('x-robots-tag', v.a.visibility === 'public' && v.a.indexable ? 'all' : 'noindex, nofollow');
    headers.append('link', `<${contentOrigin(c.env, v.a.public_id, ref)}>; rel=preconnect`);
    return new Response(html, { status: 200, headers });
  }
  const shell = await c.env.ASSETS.fetch(shellReq);
  const res = new Response(shell.body, { status: v ? 200 : 404, headers: shell.headers });
  res.headers.set('cache-control', 'private, no-store');
  res.headers.set('x-robots-tag', v && v.a.visibility === 'public' && v.a.indexable ? 'all' : 'noindex, nofollow');
  return res;
});

const UNLOCK_META_COOKIE = 'as_unlock_meta';
const UNLOCK_META_TTL = 7 * 24 * 3600;
const UNLOCK_META_MAX = 20;
interface UnlockMetaEntry { id: string; v: number; exp: number }
interface UnlockMetaClaim { k: 'unlock_meta'; items: UnlockMetaEntry[] }

async function readUnlockMeta(env: Env, req: Request): Promise<UnlockMetaEntry[]> {
  const raw = parseCookies(req.headers.get('cookie'))[`__Host-${UNLOCK_META_COOKIE}`];
  const claim = await verifyPayload<UnlockMetaClaim>(env.SECRET_KEY, raw);
  if (!claim || claim.k !== 'unlock_meta' || !Array.isArray(claim.items)) return [];
  const t = now();
  return claim.items.filter(
    (e): e is UnlockMetaEntry =>
      !!e && typeof e.id === 'string' && typeof e.v === 'number' && typeof e.exp === 'number' && e.exp > t,
  );
}

async function hasUnlockMeta(env: Env, req: Request, a: ArtifactRow): Promise<boolean> {
  const items = await readUnlockMeta(env, req);
  return items.some((e) => e.id === a.public_id && e.v === a.password_ver);
}

async function unlockMetaCookie(env: Env, req: Request, a: ArtifactRow): Promise<string> {
  const prev = await readUnlockMeta(env, req);
  const next = [
    ...prev.filter((e) => e.id !== a.public_id),
    { id: a.public_id, v: a.password_ver, exp: now() + UNLOCK_META_TTL },
  ].slice(-UNLOCK_META_MAX);
  const token = await signPayload(env.SECRET_KEY, { k: 'unlock_meta', items: next } satisfies UnlockMetaClaim);
  return hostCookie(UNLOCK_META_COOKIE, token, UNLOCK_META_TTL);
}

async function viewerInfo(c: AppContext, { a, owner }: { a: ArtifactRow; owner: boolean }, ref: URL) {
  // An access-code artifact's title is withheld until the visitor verifies the code.
  const [titleVisible, download] = await Promise.all([
    owner || a.visibility !== 'password' ? true : hasUnlockMeta(c.env, c.req.raw, a),
    downloadInfo(c.env, c.req.raw, a, owner),
  ]);
  const base = {
    download,
    public_id: a.public_id,
    title: titleVisible ? a.title : null,
    visibility: a.visibility,
    share_url: viewerUrl(c.env, a.public_id, ref),
    content_url: `${contentOrigin(c.env, a.public_id, ref)}/`,
    owner,
  };
  if (!owner) return base;
  const [artifact, frame_url] = await Promise.all([
    artifactView(c.env, a, ref),
    // The iframe signs the owner in on the subdomain, so private/code-protected content shows directly.
    ownerAuthUrl(c.env, ref, a.public_id, sessionOf(c)!.sessionId),
  ]);
  return { ...base, artifact, frame_url };
}

// Metadata for the viewer bar. Non-owners learn only what the iframe would show them anyway.
app.get('/api/public/artifacts/:pid', async (c) => {
  const v = await viewable(c, c.req.param('pid'));
  if (!v) throw new HttpError(404, 'not_found', 'Not found');
  return c.json(await viewerInfo(c, v, new URL(c.req.url)));
});

// Verifies an access code (from ?pwd=) or a signed iframe unlock proof so the viewer bar can show the real title (and keep it on reload).
app.post('/api/public/artifacts/:pid/unlock', async (c) => {
  const v = await viewable(c, c.req.param('pid'));
  if (!v) throw new HttpError(404, 'not_found', 'Not found');
  const { a, owner } = v;
  if (owner || a.visibility !== 'password') return c.json({ title: a.title });
  // Require application/json so cross-site text/plain form POSTs cannot overwrite a visitor's cookie.
  const mediaType = (c.req.header('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  const { code, proof, turnstile_token } = await readJsonObject<{ code?: unknown; proof?: unknown; turnstile_token?: unknown }>(c.req.raw, { optional: true, maxBytes: 16 * 1024 });
  if (typeof proof === 'string' && proof) {
    const p = await verifyPayload<UnlockProof>(c.env.SECRET_KEY, proof);
    if (!p || p.k !== 'unlock_proof' || p.id !== a.public_id || p.v !== a.password_ver || p.exp <= now()) {
      throw new HttpError(403, 'invalid_proof', 'Unlock proof is invalid or expired');
    }
    c.header('set-cookie', await unlockMetaCookie(c.env, c.req.raw, a));
    return c.json({ title: a.title });
  }
  const check = await verifyAccessCode(
    c.env,
    c.req.raw,
    a,
    typeof code === 'string' ? code : '',
    typeof turnstile_token === 'string' ? turnstile_token : null,
  );
  if (!check.ok) {
    const captcha = (await captchaRequired(c.env, c.req.raw, a)) ? { turnstile_site_key: c.env.TURNSTILE_SITE_KEY } : {};
    if (check.reason === 'locked') throw new HttpError(429, 'rate_limited', 'Too many attempts, try again later', { retry_after: check.retryAfter });
    if (check.reason === 'turnstile') throw new HttpError(403, 'turnstile_required', 'Complete the verification first', captcha);
    throw new HttpError(403, 'incorrect_code', 'Incorrect access code', { remaining: check.remaining, ...captcha });
  }
  c.header('set-cookie', await unlockMetaCookie(c.env, c.req.raw, a));
  return c.json({ title: a.title });
});

registerDownloadRoutes(app, viewable);

// ---------- auth ----------

app.get('/api/auth/methods', async (c) => {
  const m = await loginMethods(c.env);
  const turnstile = turnstileEnabled(c.env)
    ? { site_key: c.env.TURNSTILE_SITE_KEY, required: (await peekAttempts(c.env, loginBucket(c.req.raw))).fails >= CAPTCHA_AFTER_FAILS }
    : null;
  return c.json({ password: m.password, sso: m.sso.map((p) => ({ provider: p, name: PROVIDER_NAMES[p] })), turnstile });
});

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/** Admin username: set in the admin UI, else ADMIN_USERNAME, else "admin". Compared case-insensitively. */
async function adminUsername(env: Env): Promise<string> {
  return (await getInternal(env, 'admin_username')) ?? (env.ADMIN_USERNAME?.trim() || 'admin');
}

function parseUsername(v: unknown): string {
  const u = typeof v === 'string' ? v.trim() : '';
  if (!USERNAME_RE.test(u)) throw new HttpError(400, 'invalid_username', 'Username: 1–64 letters, digits or . _ @ -');
  return u;
}

app.post('/api/auth/login', async (c) => {
  const { username, password, turnstile_token } = await readJsonObject<{ username?: string; password?: string; turnstile_token?: string }>(c.req.raw);
  if (typeof password !== 'string' || !password || typeof username !== 'string' || !username) {
    throw new HttpError(400, 'invalid_request', 'Username and password required');
  }
  // Settings that make password sign-in impossible are answered before anything is counted.
  // Read fresh from D1 in one query (bypassing the 30 s settings cache) to keep auth decisions consistent across isolates.
  const { results: settingRows } = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('admin_password_hash', 'admin_username', 'password_login_enabled')",
  ).all<{ key: string; value: string }>();
  const settingMap = new Map(settingRows.map((r) => [r.key, r.value]));
  const hash = settingMap.get('admin_password_hash') ?? null;
  let passwordLoginEnabled = true;
  const rawPasswordLogin = settingMap.get('password_login_enabled');
  if (rawPasswordLogin !== undefined) {
    try {
      const parsed = JSON.parse(rawPasswordLogin);
      if (typeof parsed === 'boolean') passwordLoginEnabled = parsed;
    } catch {
      /* ignore corrupt values, matching getSettings */
    }
  }
  if (hash && !passwordLoginEnabled) throw new HttpError(403, 'password_login_disabled', 'Password sign-in is disabled');
  if (!hash && !c.env.ADMIN_BOOTSTRAP_PASSWORD) throw new HttpError(503, 'not_configured', 'ADMIN_BOOTSTRAP_PASSWORD is not set');

  const storedUsername = settingMap.get('admin_username') ?? null;
  const expectedUsername = storedUsername ?? (c.env.ADMIN_USERNAME?.trim() || 'admin');
  const method = hash ? 'password' : 'bootstrap';
  const result = await guardedAttempt(c.env, c.req.raw, loginBucket(c.req.raw), typeof turnstile_token === 'string' ? turnstile_token : null, async () => {
    // Both checked (no early return), and the error never says which of the two was wrong.
    const userOk = timingSafeEqualStr(username.trim().toLowerCase(), expectedUsername.toLowerCase());
    const passOk = hash ? await verifyPassword(password, hash) : timingSafeEqualStr(password, c.env.ADMIN_BOOTSTRAP_PASSWORD!);
    return userOk && passOk;
  });
  if (!result.ok) {
    if (result.reason === 'turnstile') throw new HttpError(403, 'turnstile_required', 'Complete the verification to sign in');
    if (result.reason === 'locked') throw new HttpError(429, 'rate_limited', 'Too many attempts, try again later', { retry_after: result.retryAfter });
    throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password');
  }
  c.header('set-cookie', await createSession(c.env, c.req.raw, method, { hash, username: storedUsername }));
  return c.json({ ok: true, needs_password_setup: method === 'bootstrap' });
});

app.post('/api/auth/logout', async (c) => {
  const s = sessionOf(c);
  if (s) c.header('set-cookie', await destroySession(c.env, s.sessionId));
  c.header('set-cookie', clearHostCookie(UNLOCK_META_COOKIE), { append: true });
  return c.json({ ok: true });
});

app.post('/api/auth/logout-all', requireSession, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions').run();
  c.header('set-cookie', await destroySession(c.env, sessionOf(c)!.sessionId));
  c.header('set-cookie', clearHostCookie(UNLOCK_META_COOKIE), { append: true });
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const a = c.get('auth');
  if (!a) throw new HttpError(401, 'unauthorized', 'Not signed in');
  const analytics_enabled = analyticsEnabled(c.env);
  if (a.type === 'token') return c.json({ type: 'token', analytics_enabled });
  return c.json({ type: 'session', method: a.method, needs_password_setup: a.method === 'bootstrap', username: await adminUsername(c.env), analytics_enabled });
});

app.get('/api/auth/oauth/:provider/start', async (c) => {
  const p = providerParam(c);
  const purpose = c.req.query('purpose') === 'bind' ? 'bind' : 'login';
  if (purpose === 'bind') {
    const s = sessionOf(c);
    if (!s || s.method === 'bootstrap') return c.redirect('/#/login');
  }
  const fallback = purpose === 'bind' ? '/#/settings' : '/';
  try {
    return c.redirect(await startUrl(c.env, new URL(c.req.url), p, purpose, c.req.query('redirect_to') ?? fallback, sessionOf(c)?.sessionId));
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return ssoErrorRedirect(c, purpose, e.code, e.message);
  }
});

app.get('/api/auth/oauth/:provider/callback', async (c) => {
  const p = providerParam(c);
  try {
    const s = sessionOf(c);
    const r = await handleCallback(c.env, new URL(c.req.url), p, s?.method === 'bootstrap' ? undefined : s?.sessionId);
    if (r.purpose === 'bind') {
      if (!s || s.method === 'bootstrap') return ssoErrorRedirect(c, 'login', 'sso_session_expired', 'Session expired; sign in and bind again');
      await setBinding(c.env, p, r.subject, r.display, { config: r.config, sessionId: s.sessionId });
      return c.redirect(`/#/settings?sso_bound=${p}`);
    }
    const row = await getProvider(c.env, p);
    if (!canLogin(row) || row.bound_subject !== r.subject || row.client_id !== r.config.client_id || row.client_secret_enc !== r.config.client_secret_enc || row.issuer !== r.config.issuer) {
      return ssoErrorRedirect(c, 'login', 'sso_not_allowed', 'This account is not allowed to sign in');
    }
    c.header('set-cookie', await createSession(c.env, c.req.raw, p, {
      subject: r.subject, clientId: r.config.client_id, secret: r.config.client_secret_enc, issuer: r.config.issuer,
    }));
    return c.redirect(safeRelativePath(r.redirectTo));
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return ssoErrorRedirect(c, (e as HttpError & { purpose?: string }).purpose, e.code, e.message);
  }
});

/** Redirects back to the SPA with an error code it can translate, plus the raw message. */
function ssoErrorRedirect(c: AppContext, purpose: string | undefined, code: string, detail: string) {
  const q = `${purpose === 'bind' ? 'sso_error' : 'error'}=${encodeURIComponent(code)}&detail=${encodeURIComponent(detail)}`;
  return c.redirect(purpose === 'bind' ? `/#/settings?${q}` : `/#/login?${q}`);
}

function providerParam(c: AppContext): Provider {
  const p = c.req.param('provider') ?? '';
  if (!isProvider(p)) throw new HttpError(404, 'not_found', 'Unknown provider');
  return p;
}

// ---------- settings (session only) ----------

// Registered before every settings/token route (Hono runs handlers in registration order). Settings need a full
// session — except PUT /api/settings/password, which a first-run bootstrap session must reach (it checks the
// session itself).
app.use('/api/settings/*', (c, next) => (c.req.method === 'PUT' && c.req.path === '/api/settings/password' ? next() : requireSession(c, next)));
app.use('/api/settings', requireSession);
app.use('/api/v1/tokens/*', requireSession);
app.use('/api/v1/tokens', requireSession);

app.put('/api/settings/password', async (c) => {
  const s = sessionOf(c);
  if (!s) throw new HttpError(401, 'unauthorized', 'Authentication required');
  const body = await readJsonObject<{ current_password?: string; new_password?: string; username?: string }>(c.req.raw);
  const username = body.username !== undefined ? parseUsername(body.username) : null;
  if (typeof body.new_password !== 'string' || body.new_password.length < 8 || body.new_password.length > 200) {
    throw new HttpError(400, 'weak_password', 'Password must be 8–200 characters');
  }
  const hash = await getInternal(c.env, 'admin_password_hash');
  // Once a real password exists, changing it always needs that password — a leftover bootstrap
  // session must not be able to take over the account.
  if (hash && (typeof body.current_password !== 'string' || !(await verifyPassword(body.current_password, hash)))) {
    throw new HttpError(403, 'wrong_current_password', 'Current password is incorrect');
  }
  const newHash = await hashPassword(body.new_password);
  const t = now();
  const changed = "(SELECT value FROM settings WHERE key = 'admin_password_hash') = ?";
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at)
       SELECT 'admin_password_hash', ?, ? WHERE (SELECT value FROM settings WHERE key = 'admin_password_hash') IS ?
         AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(newHash, t, hash, s.sessionId, t),
  ];
  if (username) {
    statements.push(c.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) SELECT 'admin_username', ?, ? WHERE ${changed}
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(username, t, newHash));
  }
  // Change credentials and revoke other sessions together. An earlier password check cannot overwrite
  // a password already changed by another request.
  statements.push(
    c.env.DB.prepare(`UPDATE sessions SET method = 'password' WHERE id = ? AND method = 'bootstrap' AND ${changed}`).bind(s.sessionId, newHash),
    c.env.DB.prepare(`DELETE FROM sessions WHERE id != ? AND ${changed}`).bind(s.sessionId, newHash),
  );
  const [result] = await c.env.DB.batch(statements);
  if (!result.meta.changes) throw new HttpError(409, 'auth_config_changed', 'Sign-in settings changed; sign in again');

  return c.json({ ok: true });
});

app.put('/api/settings/username', async (c) => {
  const body = await readJsonObject<{ username?: string; current_password?: string }>(c.req.raw);
  const username = parseUsername(body.username);
  const hash = await getInternal(c.env, 'admin_password_hash');
  if (!hash || typeof body.current_password !== 'string' || !(await verifyPassword(body.current_password, hash))) {
    throw new HttpError(403, 'wrong_current_password', 'Current password is incorrect');
  }
  await setInternal(c.env, 'admin_username', username);
  return c.json({ ok: true, username });
});


app.get('/api/settings', async (c) => c.json(await getSettings(c.env)));

app.patch('/api/settings', async (c) => {
  const patch = await readJsonObject(c.req.raw);
  if (patch.password_login_enabled === false) {
    const m = await loginMethods(c.env);
    if (m.sso.length === 0) throw new HttpError(400, 'lockout', 'Enable and bind at least one SSO provider before disabling password sign-in');
    if (!(await getInternal(c.env, 'admin_password_hash'))) throw new HttpError(400, 'lockout', 'Set an admin password first');
  }
  return c.json(await updateSettings(c.env, patch));
});

app.get('/api/settings/sso', async (c) => {
  const ref = new URL(c.req.url);
  const rows = await listProviders(c.env);
  return c.json({
    items: rows.map((r) => ({
      provider: r.provider,
      name: PROVIDER_NAMES[r.provider],
      enabled: !!r.enabled,
      client_id: r.client_id,
      has_secret: !!r.client_secret_enc,
      issuer: r.issuer,
      bound: r.bound_subject ? { display: r.bound_display, at: r.bound_at } : null,
      callback_url: callbackUrl(c.env, ref, r.provider),
    })),
  });
});

async function assertNotLastMethod(env: Env, p: Provider) {
  const m = await loginMethods(env);
  if (!m.password && m.sso.length === 1 && m.sso[0] === p) {
    throw new HttpError(400, 'lockout', 'This is your only sign-in method; re-enable password sign-in first');
  }
}

app.put('/api/settings/sso/:provider', async (c) => {
  const p = providerParam(c);
  const body = await readJsonObject(c.req.raw);
  const patch: Parameters<typeof saveProvider>[2] = {};
  for (const k of ['client_id', 'client_secret', 'issuer'] as const) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'string' || (body[k] as string).length > 500) throw new HttpError(400, 'invalid_request', `${k} must be a string`);
      patch[k] = body[k] as string;
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'invalid_request', 'enabled must be a boolean');
    patch.enabled = body.enabled;
  }
  const cur = await getProvider(c.env, p);
  // Anything that could break this provider's sign-in — including a new secret, which can't be validated
  // until someone signs in with it — is refused while it is the only way to sign in.
  const dropsLogin =
    patch.enabled === false ||
    (patch.client_id !== undefined && patch.client_id.trim() !== (cur.client_id ?? '')) ||
    (patch.issuer !== undefined && patch.issuer.trim().replace(/\/+$/, '') !== (cur.issuer ?? '')) ||
    (patch.client_secret !== undefined && patch.client_secret.trim() !== '');
  if (dropsLogin && canLogin(cur)) await assertNotLastMethod(c.env, p);
  await saveProvider(c.env, p, patch);
  return c.json({ ok: true });
});

app.delete('/api/settings/sso/:provider/binding', async (c) => {
  const p = providerParam(c);
  if (canLogin(await getProvider(c.env, p))) await assertNotLastMethod(c.env, p);
  await setBinding(c.env, p, null, null);
  return c.json({ ok: true });
});

// ---------- API tokens (session only) ----------

app.get('/api/v1/tokens', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC').all();
  return c.json({ items: results });
});

app.post('/api/v1/tokens', async (c) => {
  const { name } = await readJsonObject<{ name?: string }>(c.req.raw);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new HttpError(400, 'invalid_request', 'name is required (≤100 chars)');
  const token = `as_${randomBase62(40)}`;
  const id = randomBase62(16);
  await c.env.DB.prepare('INSERT INTO api_tokens (id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name.trim(), await sha256Hex(token), token.slice(0, 8), now())
    .run();
  return c.json({ id, name: name.trim(), token }, 201);
});

app.delete('/api/v1/tokens/:id', async (c) => {
  await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now(), c.req.param('id')).run();
  return c.body(null, 204);
});

// ---------- artifacts & uploads ----------

app.route('/api/v1', api);

app.all('/api/*', () => jsonError(404, 'not_found', 'Not found'));

// ---------- private preview handoff ----------

app.get('/handoff', async (c) => {
  const id = (c.req.query('id') ?? '').toLowerCase();
  const next = safeRelativePath(c.req.query('next'));
  const s = sessionOf(c);
  if (s?.method === 'bootstrap') return c.redirect('/#/setup'); // finish first-run setup first
  if (!s) {
    const back = `/handoff?id=${encodeURIComponent(id)}&next=${encodeURIComponent(next)}`;
    return c.redirect(`/#/login?next=${encodeURIComponent(back)}`);
  }
  // `id` is the internal id (admin UI) or the subdomain id (owner sign-in link on a content page).
  const a = isUuid(id) ? ((await getArtifact(c.env, id)) ?? (await getArtifactByPublicId(c.env, id))) : null;
  if (!a) return c.redirect('/#/');
  c.header('cache-control', 'no-store');
  return c.redirect(await ownerAuthUrl(c.env, new URL(c.req.url), a.public_id, s.sessionId, next));
});

// ---------- admin SPA ----------

const STATIC_ASSET_RE = /\.(?:js|css|svg)$/i;
const STATIC_ASSET_CACHE = 'public, max-age=300, stale-while-revalidate=86400';

app.all('*', async (c) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method not allowed', 405);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  const contentType = (out.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (out.status === 200 && STATIC_ASSET_RE.test(c.req.path) && contentType !== 'text/html') {
    out.headers.set('cache-control', STATIC_ASSET_CACHE);
  }
  return out;
});
