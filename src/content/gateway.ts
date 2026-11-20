import type { ArtifactRow, Env } from '../env';
import { signPayload, verifyPayload } from '../lib/crypto';
import { mainOrigin } from '../lib/hosts';
import { clearHostCookie, hostCookie, HttpError, localPath, now, parseCookies, readBodyLimited, safeRelativePath } from '../lib/http';
import { type AttemptResult, captchaRequired, verifyAccessCode } from '../lib/access';
import { getArtifactByPublicId } from '../lib/store';
import { cookiesBlockedPage, errorPage, LANG_PARAM, type MessageKey, notFoundPage, type PageCtx, resolveLang, type UnlockError, unlockPage } from './pages';
import { serveFile } from './serve';

const OWNER_TTL = 12 * 3600;
const UNLOCK_TTL = 7 * 24 * 3600;

/** `sid` binds the owner cookie to the admin session: signing out (or out everywhere) revokes it at once. */
interface OwnerClaim { k: 'owner'; id: string; sid: string; exp: number }
interface UnlockClaim { k: 'unlock'; id: string; v: number; exp: number }
export interface HandoffTicket { k: 'handoff'; id: string; sid: string; exp: number; n: string }

async function isOwner(env: Env, cookies: Record<string, string>, id: string): Promise<boolean> {
  const c = await verifyPayload<OwnerClaim>(env.SECRET_KEY, cookies['__Host-as_owner']);
  if (!c || c.k !== 'owner' || c.id !== id || c.exp <= now() || typeof c.sid !== 'string') return false;
  return !!(await env.DB.prepare("SELECT 1 FROM sessions WHERE id = ? AND method != 'bootstrap' AND expires_at > ?").bind(c.sid, now()).first());
}

async function isUnlocked(env: Env, cookies: Record<string, string>, a: ArtifactRow): Promise<boolean> {
  const c = await verifyPayload<UnlockClaim>(env.SECRET_KEY, cookies['__Host-as_unlock']);
  return !!c && c.k === 'unlock' && c.id === a.public_id && c.v === a.password_ver && c.exp > now();
}

async function unlockCookie(env: Env, a: ArtifactRow): Promise<string> {
  const token = await signPayload(env.SECRET_KEY, { k: 'unlock', id: a.public_id, v: a.password_ver, exp: now() + UNLOCK_TTL } satisfies UnlockClaim);
  return hostCookie('as_unlock', token, UNLOCK_TTL, { embedded: true });
}


function redirect(location: string, status = 302, cookies: string[] = []): Response {
  const h = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status, headers: h });
}

const robotsDisallow = () =>
  new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** Content may only be framed by itself and the main domain's viewer page. */
export function frameAncestors(env: Env, req: Request): string {
  return `'self' ${mainOrigin(env, new URL(req.url))}`;
}

export function pageCtx(env: Env, req: Request): PageCtx {
  const explicit = new URL(req.url).searchParams.get(LANG_PARAM);
  return { lang: resolveLang(explicit, req.headers.get('accept-language')), ancestors: frameAncestors(env, req) };
}

/**
 * Set on the redirect right after a cookie is issued. If the follow-up request arrives without that cookie,
 * the browser is blocking third-party cookies (e.g. Safari in the viewer's iframe): show a way out instead
 * of looping back to the unlock page.
 */
const CHECK_PARAM = '__chk';

/** Path + query to return to, without the gateway's own parameters (they must never reach the artifact). */
function returnPath(url: URL, drop: string[] = []): string {
  const q = new URLSearchParams(url.search);
  for (const k of [LANG_PARAM, CHECK_PARAM, ...drop]) q.delete(k);
  return localPath(url.pathname) + (q.size ? `?${q}` : '');
}

/**
 * `path` plus the cookie-check marker (and the page language, so a fallback page keeps it). A `?pwd=` code
 * rides along so the "open in a new tab" fallback can still carry it; the check hop strips it otherwise.
 */
function withCheck(path: string, ctx: PageCtx, pwd?: string): string {
  const u = new URL(path, 'https://base.invalid');
  u.searchParams.set(CHECK_PARAM, '1');
  u.searchParams.set(LANG_PARAM, ctx.lang);
  if (pwd) u.searchParams.set('pwd', pwd);
  return u.pathname + u.search;
}

export async function handleContent(req: Request, env: Env, execCtx: ExecutionContext, id: string): Promise<Response> {
  const url = new URL(req.url);
  const ctx: PageCtx = pageCtx(env, req);
  if (url.pathname.startsWith('/__share/')) return shareRoutes(req, env, id, url, ctx);
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });

  const ownerLogin = `${mainOrigin(env, url)}/handoff?id=${id}&next=${encodeURIComponent(returnPath(url))}`;
  const a = await getArtifactByPublicId(env, id);
  if (!a || a.current_version == null) return notFoundPage(ctx, ownerLogin);

  const indexable = a.visibility === 'public' && !!a.indexable;

  const cookies = parseCookies(req.headers.get('cookie'));
  const owner = await isOwner(env, cookies, id);

  if (url.searchParams.has(CHECK_PARAM)) {
    const allowed = owner || a.visibility === 'public' || (a.visibility === 'password' && (await isUnlocked(env, cookies, a)));
    if (allowed) return redirect(returnPath(url, ['pwd']));
    // Private: look exactly like a normal miss (no existence oracle). Its "owner sign-in" link opens
    // top-level, where cookies are first-party, so a blocked-cookie owner still gets in.
    if (a.visibility === 'private') return notFoundPage(ctx, ownerLogin);
    // Cookie was dropped: open the artifact top-level, where cookies are first-party.
    // Keep a ?pwd= code (if the share link had one) so the top-level tab unlocks without retyping.
    const target = new URL(returnPath(url, ['pwd']), url.origin);
    const pwd = url.searchParams.get('pwd');
    if (pwd) target.searchParams.set('pwd', pwd);
    return cookiesBlockedPage(ctx, target.toString());
  }

  if (!owner && a.visibility === 'private') return notFoundPage(ctx, ownerLogin);
  // After the private check: answering robots.txt first would reveal that a private artifact exists.
  if (url.pathname === '/robots.txt' && !indexable) return robotsDisallow();

  if (!owner && a.visibility === 'password') {
    const pwd = url.searchParams.get('pwd');
    if (pwd !== null) {
      const clean = returnPath(url, ['pwd']);
      // A link can't carry a Turnstile token: when one is required, show the form with the code filled in.
      const check = await verifyAccessCode(env, req, a, pwd);
      if (!check.ok) return renderUnlock(env, req, a, ctx, clean, check, pwd);
      return redirect(withCheck(clean, ctx, pwd), 302, [await unlockCookie(env, a)]);
    }
    if (!(await isUnlocked(env, cookies, a))) {
      return renderUnlock(env, req, a, ctx, returnPath(url));
    }
  }

  // `__lang` (viewer → gateway pages) is a reserved, double-underscore name: never handed to the artifact.
  // `pwd` is only reserved in password mode (handled above) — a public artifact may use it for itself.
  if (url.searchParams.has(LANG_PARAM) || (a.visibility === 'password' && url.searchParams.has('pwd'))) {
    return redirect(returnPath(url, a.visibility === 'password' ? ['pwd'] : []));
  }
  // The owner's own previews are not views.
  return serveFile(req, env, execCtx, a, { isPublic: a.visibility === 'public' && !owner, ancestors: ctx.ancestors, countView: !owner });
}

/** The unlock form, with the error of a failed attempt and Turnstile when this IP now needs it. */
async function renderUnlock(env: Env, req: Request, a: ArtifactRow, ctx: PageCtx, next: string, check?: Exclude<AttemptResult, { ok: true }>, code?: string): Promise<Response> {
  const captchaSiteKey = (await captchaRequired(env, req, a)) ? env.TURNSTILE_SITE_KEY : undefined;
  let error: UnlockError | undefined;
  let status = 401;
  switch (check?.reason) {
    case 'incorrect':
      error = { key: 'incorrect', n: check.remaining };
      break;
    case 'turnstile':
      error = { key: 'turnstile' };
      status = 403;
      break;
    case 'locked':
      error = { key: 'locked', n: Math.ceil(check.retryAfter / 60) };
      status = 429;
      break;
  }
  const res = unlockPage(ctx, { next, error, status, captchaSiteKey, code: check?.reason === 'incorrect' ? undefined : code });
  if (check?.reason === 'locked') res.headers.set('retry-after', String(check.retryAfter));
  return res;
}

async function shareRoutes(req: Request, env: Env, id: string, url: URL, ctx: PageCtx): Promise<Response> {
  const fail = (status: number, key: MessageKey) => errorPage(ctx, status, key);
  switch (url.pathname) {
    case '/__share/unlock': {
      if (req.method !== 'POST') return redirect('/');
      const a = await getArtifactByPublicId(env, id);
      if (!a || a.visibility !== 'password') return redirect('/', 303);
      let data: Uint8Array;
      try {
        data = await readBodyLimited(req, 32 * 1024, 'request_too_large');
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        return new Response('Request too large', { status: e.status, headers: { 'cache-control': 'no-store' } });
      }
      const form = await new Response(data, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData().catch(() => null);
      const code = String(form?.get('code') ?? '');
      const next = safeRelativePath(String(form?.get('next') ?? '/'));
      // The unlock form carries the viewer's language, so a failed attempt re-renders in it.
      ctx = { ...ctx, lang: resolveLang(String(form?.get(LANG_PARAM) ?? ''), req.headers.get('accept-language')) };
      const check = await verifyAccessCode(env, req, a, code, form?.get('cf-turnstile-response') as string | null);
      if (!check.ok) return renderUnlock(env, req, a, ctx, next, check, code);
      return redirect(withCheck(next, ctx), 303, [await unlockCookie(env, a)]);
    }
    case '/__share/auth': {
      const t = await verifyPayload<HandoffTicket>(env.SECRET_KEY, url.searchParams.get('ticket'));
      if (!t || t.k !== 'handoff' || t.id !== id || t.exp < now() || typeof t.n !== 'string' || typeof t.sid !== 'string') return fail(403, 'invalidLink');
      const res = await env.DB.prepare('INSERT OR IGNORE INTO used_nonces (nonce, expires_at) VALUES (?, ?)').bind(t.n, t.exp + 60).run();
      if (!res.meta.changes) return fail(403, 'usedLink');
      const token = await signPayload(env.SECRET_KEY, { k: 'owner', id, sid: t.sid, exp: now() + OWNER_TTL } satisfies OwnerClaim);
      return redirect(withCheck(safeRelativePath(url.searchParams.get('next')), ctx), 302, [hostCookie('as_owner', token, OWNER_TTL, { embedded: true })]);
    }
    case '/__share/logout':
      return redirect('/', 302, [clearHostCookie('as_owner', { embedded: true }), clearHostCookie('as_unlock', { embedded: true })]);
    default:
      return notFoundPage(ctx);
  }
}
