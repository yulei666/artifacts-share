import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { randomToken, sha256Hex } from '../lib/crypto';
import { forgetSessions } from '../lib/sessioncache';
import { mainOrigin } from '../lib/hosts';
import { clearHostCookie, clientIp, HttpError, hostCookie, now, parseCookies } from '../lib/http';

export const SESSION_TTL = 30 * 24 * 3600;
const SESSION_COOKIE = '__Host-as_session';

export type Auth =
  | { type: 'session'; sessionId: string; method: string }
  | { type: 'token'; tokenId: string };

export type AppEnv = { Bindings: Env; Variables: { auth: Auth | null } };
export type AppContext = Context<AppEnv>;
type Waiter = { waitUntil(p: Promise<unknown>): void };

export async function createSession(env: Env, req: Request, method: string): Promise<string> {
  const raw = randomToken(32);
  const t = now();
  await env.DB.prepare('INSERT INTO sessions (id, method, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(raw), method, t, t + SESSION_TTL, (req.headers.get('user-agent') ?? '').slice(0, 300), clientIp(req))
    .run();
  return hostCookie('as_session', raw, SESSION_TTL);
}

export async function destroySession(env: Env, sessionId: string): Promise<string> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  forgetSessions(sessionId);
  return clearHostCookie('as_session');
}

async function sessionAuth(env: Env, ctx: Waiter, req: Request): Promise<{ auth: Auth; refreshCookie?: string } | null> {
  const raw = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (!raw) return null;
  const id = await sha256Hex(raw);
  const row = await env.DB.prepare('SELECT id, method, expires_at FROM sessions WHERE id = ?').bind(id).first<{ id: string; method: string; expires_at: number }>();
  const t = now();
  if (!row || row.expires_at <= t) return null;
  const auth: Auth = { type: 'session', sessionId: id, method: row.method };
  // Sliding expiry, refreshed at most once a day — in the DB *and* in the browser (re-issue the cookie
  // with a fresh Max-Age, or the browser would still drop it at the original expiry).
  if (row.expires_at - t < SESSION_TTL - 86400) {
    ctx.waitUntil(env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(t + SESSION_TTL, id).run());
    return { auth, refreshCookie: hostCookie('as_session', raw, SESSION_TTL) };
  }
  return { auth };
}

async function tokenAuth(env: Env, ctx: Waiter, token: string): Promise<Auth> {
  const row = await env.DB.prepare('SELECT id, last_used_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(await sha256Hex(token))
    .first<{ id: string; last_used_at: number | null }>();
  if (!row) throw new HttpError(401, 'invalid_token', 'Invalid or revoked API token');
  const t = now();
  if (!row.last_used_at || t - row.last_used_at > 60) {
    ctx.waitUntil(env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(t, row.id).run());
  }
  return { type: 'token', tokenId: row.id };
}

/** Resolves the caller (Bearer token or session cookie) and enforces the CSRF origin check for cookie auth. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization');
  let auth: Auth | null = null;
  let refreshCookie: string | undefined;
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) throw new HttpError(401, 'invalid_token', 'Malformed Authorization header');
    auth = await tokenAuth(c.env, c.executionCtx, m[1]);
  } else {
    const s = await sessionAuth(c.env, c.executionCtx, c.req.raw);
    auth = s?.auth ?? null;
    refreshCookie = s?.refreshCookie;
    if (auth && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) assertSameOrigin(c);
  }
  c.set('auth', auth);
  await next();
  // Don't override a handler that changed the session cookie itself (login, logout).
  if (refreshCookie && !c.res.headers.getSetCookie().some((h) => h.startsWith(`${SESSION_COOKIE}=`))) {
    c.res.headers.append('set-cookie', refreshCookie);
  }
};

function assertSameOrigin(c: AppContext) {
  const origin = c.req.header('origin');
  const expected = mainOrigin(c.env, new URL(c.req.url));
  if (origin) {
    if (origin !== expected) throw new HttpError(403, 'csrf', 'Cross-origin request rejected');
    return;
  }
  if (c.req.header('sec-fetch-site') !== 'same-origin') throw new HttpError(403, 'csrf', 'Missing Origin header');
}

/** Any authenticated caller (token or full session). */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth) throw new HttpError(401, 'unauthorized', 'Authentication required');
  if (auth.type === 'session' && auth.method === 'bootstrap') throw new HttpError(403, 'password_setup_required', 'Set an admin password first');
  await next();
};

/** Session only (tokens cannot manage tokens or settings). */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (!auth) throw new HttpError(401, 'unauthorized', 'Authentication required');
  if (auth.type !== 'session') throw new HttpError(403, 'session_required', 'This endpoint requires an admin session');
  if (auth.method === 'bootstrap') throw new HttpError(403, 'password_setup_required', 'Set an admin password first');
  await next();
};

export function sessionOf(c: AppContext): { sessionId: string; method: string } | null {
  const a = c.get('auth');
  return a?.type === 'session' ? a : null;
}

export function actor(c: AppContext): string {
  const a = c.get('auth');
  return a?.type === 'token' ? `token:${a.tokenId}` : 'session';
}
