import { Hono } from 'hono';
import type { Env } from '../env';
import { hashPassword, randomBase62, randomToken, sha256Hex, signPayload, timingSafeEqualStr, verifyPassword } from '../lib/crypto';
import { contentOrigin, isUuid } from '../lib/hosts';
import { clientIp, HttpError, jsonError, now, readJsonObject, safeRelativePath } from '../lib/http';
import { peekAttempts } from '../lib/ratelimit';
import { guardedAttempt, loginBucket } from '../lib/access';
import { forgetSessions } from '../lib/sessioncache';
import { CAPTCHA_AFTER_FAILS, turnstileEnabled } from '../lib/turnstile';
import { getInternal, getSettings, setInternal, updateSettings } from '../lib/settings';
import { artifactView, getArtifact, getArtifactByPublicId, viewerUrl } from '../lib/store';
import type { HandoffTicket } from '../content/gateway';
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
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/viewer', c.req.url)));
  const res = new Response(shell.body, { status: v ? 200 : 404, headers: shell.headers });
  res.headers.set('cache-control', 'private, no-store');
  res.headers.set('x-robots-tag', v && v.a.visibility === 'public' && v.a.indexable ? 'all' : 'noindex, nofollow');
  return res;
});

// Metadata for the viewer bar. Non-owners learn only what the iframe would show them anyway.
app.get('/api/public/artifacts/:pid', async (c) => {
  const v = await viewable(c, c.req.param('pid'));
  if (!v) throw new HttpError(404, 'not_found', 'Not found');
  const { a, owner } = v;
  const ref = new URL(c.req.url);
  const base = {
    download: await downloadInfo(c.env, c.req.raw, a, owner),
    public_id: a.public_id,
    // An access-code artifact's title is withheld until the visitor can see the content.
    title: a.visibility === 'password' && !owner ? null : a.title,
    visibility: a.visibility,
    share_url: viewerUrl(c.env, a.public_id, ref),
    content_url: `${contentOrigin(c.env, a.public_id, ref)}/`,
    owner,
  };
  if (!owner) return c.json(base);
  return c.json({
    ...base,
    artifact: await artifactView(c.env, a, ref),
    // The iframe signs the owner in on the subdomain, so private/code-protected content shows directly.
    frame_url: await ownerAuthUrl(c.env, ref, a.public_id, sessionOf(c)!.sessionId),
  });
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
  const hash = await getInternal(c.env, 'admin_password_hash');
  const settings = await getSettings(c.env, { fresh: true });
  if (hash && !settings.password_login_enabled) throw new HttpError(403, 'password_login_disabled', 'Password sign-in is disabled');
  if (!hash && !c.env.ADMIN_BOOTSTRAP_PASSWORD) throw new HttpError(503, 'not_configured', 'ADMIN_BOOTSTRAP_PASSWORD is not set');

  const method = hash ? 'password' : 'bootstrap';
  const result = await guardedAttempt(c.env, c.req.raw, loginBucket(c.req.raw), typeof turnstile_token === 'string' ? turnstile_token : null, async () => {
    // Both checked (no early return), and the error never says which of the two was wrong.
    const userOk = timingSafeEqualStr(username.trim().toLowerCase(), (await adminUsername(c.env)).toLowerCase());
    const passOk = hash ? await verifyPassword(password, hash) : timingSafeEqualStr(password, c.env.ADMIN_BOOTSTRAP_PASSWORD!);
    return userOk && passOk;
  });
  if (!result.ok) {
    if (result.reason === 'turnstile') throw new HttpError(403, 'turnstile_required', 'Complete the verification to sign in');
    if (result.reason === 'locked') throw new HttpError(429, 'rate_limited', 'Too many attempts, try again later', { retry_after: result.retryAfter });
    throw new HttpError(401, 'invalid_credentials', 'Incorrect username or password');
  }
  c.header('set-cookie', await createSession(c.env, c.req.raw, method));
  return c.json({ ok: true, needs_password_setup: method === 'bootstrap' });
});

app.post('/api/auth/logout', async (c) => {
  const s = sessionOf(c);
  if (s) c.header('set-cookie', await destroySession(c.env, s.sessionId));
  return c.json({ ok: true });
});

app.post('/api/auth/logout-all', requireSession, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions').run();
  forgetSessions();
  c.header('set-cookie', await destroySession(c.env, sessionOf(c)!.sessionId));
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const a = c.get('auth');
  if (!a) throw new HttpError(401, 'unauthorized', 'Not signed in');
  if (a.type === 'token') return c.json({ type: 'token' });
  return c.json({ type: 'session', method: a.method, needs_password_setup: a.method === 'bootstrap', username: await adminUsername(c.env) });
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
    return c.redirect(await startUrl(c.env, new URL(c.req.url), p, purpose, c.req.query('redirect_to') ?? fallback));
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return ssoErrorRedirect(c, purpose, e.code, e.message);
  }
});

app.get('/api/auth/oauth/:provider/callback', async (c) => {
  const p = providerParam(c);
  try {
    const r = await handleCallback(c.env, new URL(c.req.url), p);
    if (r.purpose === 'bind') {
      const s = sessionOf(c);
      if (!s || s.method === 'bootstrap') return ssoErrorRedirect(c, 'login', 'sso_session_expired', 'Session expired; sign in and bind again');
      await setBinding(c.env, p, r.subject, r.display);
      return c.redirect(`/#/settings?sso_bound=${p}`);
    }
    const row = await getProvider(c.env, p);
    if (!canLogin(row) || row.bound_subject !== r.subject) {
      return ssoErrorRedirect(c, 'login', 'sso_not_allowed', 'This account is not allowed to sign in');
    }
    c.header('set-cookie', await createSession(c.env, c.req.raw, p));
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
  await setInternal(c.env, 'admin_password_hash', await hashPassword(body.new_password));
  if (username) await setInternal(c.env, 'admin_username', username);
  // A password change is often a reaction to a leak: sign out every other session (and, with them, the
  // owner cookies on content hosts that are bound to them). This one stays, upgraded from bootstrap.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sessions SET method = 'password' WHERE id = ? AND method = 'bootstrap'").bind(s.sessionId),
    c.env.DB.prepare('DELETE FROM sessions WHERE id != ?').bind(s.sessionId),
  ]);
  forgetSessions();
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
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
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

app.all('*', async (c) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method not allowed', 405);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);
});
