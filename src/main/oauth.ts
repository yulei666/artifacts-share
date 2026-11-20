import type { Env } from '../env';
import { b64url, decryptString, encryptString, randomToken, sha256 } from '../lib/crypto';
import { mainOrigin } from '../lib/hosts';
import { HttpError, now, safeRelativePath } from '../lib/http';
import { verifyIdToken } from '../lib/jwt';
import { getInternal, getSettings } from '../lib/settings';

export const PROVIDERS = ['google', 'github', 'cloudflare'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_NAMES: Record<Provider, string> = { google: 'Google', github: 'GitHub', cloudflare: 'Cloudflare' };

export function isProvider(p: string): p is Provider {
  return (PROVIDERS as readonly string[]).includes(p);
}

export interface ProviderRow {
  provider: Provider;
  enabled: number;
  client_id: string | null;
  client_secret_enc: string | null;
  issuer: string | null;
  bound_subject: string | null;
  bound_display: string | null;
  bound_at: number | null;
  updated_at: number;
}

interface Endpoints {
  authorize: string;
  token: string;
  scope: string;
  oidc?: { issuer: string | string[]; jwksUri: string };
}

const discoveryCache = new Map<string, { at: number; value: Endpoints }>();

async function endpoints(row: ProviderRow): Promise<Endpoints> {
  switch (row.provider) {
    case 'google':
      return {
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        scope: 'openid email',
        oidc: { issuer: ['https://accounts.google.com', 'accounts.google.com'], jwksUri: 'https://www.googleapis.com/oauth2/v3/certs' },
      };
    case 'github':
      return { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'read:user' };
    case 'cloudflare': {
      const issuer = row.issuer?.replace(/\/+$/, '');
      if (!issuer) throw new HttpError(400, 'sso_not_configured', 'Cloudflare issuer is not configured');
      const hit = discoveryCache.get(issuer);
      if (hit && Date.now() - hit.at < 3600_000) return hit.value;
      const res = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new HttpError(502, 'sso_discovery_failed', `OIDC discovery failed (${res.status})`);
      const d = (await res.json()) as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
      // OIDC Discovery §4.3: the document's issuer must be exactly the configured one.
      if (typeof d.issuer !== 'string' || d.issuer.replace(/\/+$/, '') !== issuer) {
        throw new HttpError(502, 'sso_discovery_failed', 'OIDC discovery issuer does not match the configured issuer');
      }
      const value: Endpoints = {
        authorize: d.authorization_endpoint,
        token: d.token_endpoint,
        scope: 'openid email profile',
        oidc: { issuer: d.issuer, jwksUri: d.jwks_uri },
      };
      discoveryCache.set(issuer, { at: Date.now(), value });
      return value;
    }
  }
}

const defaultProvider = (p: Provider): ProviderRow => ({
  provider: p,
  enabled: 0,
  client_id: null,
  client_secret_enc: null,
  issuer: null,
  bound_subject: null,
  bound_display: null,
  bound_at: null,
  updated_at: 0,
});

export async function getProvider(env: Env, p: Provider): Promise<ProviderRow> {
  const row = await env.DB.prepare('SELECT * FROM sso_providers WHERE provider = ?').bind(p).first<ProviderRow>();
  return row ?? defaultProvider(p);
}

export async function listProviders(env: Env): Promise<ProviderRow[]> {
  // One query for all providers; unconfigured ones get defaults.
  const { results } = await env.DB.prepare('SELECT * FROM sso_providers').all<ProviderRow>();
  return PROVIDERS.map((p) => results.find((r) => r.provider === p) ?? defaultProvider(p));
}

export const callbackUrl = (env: Env, ref: URL, p: Provider) => `${mainOrigin(env, ref)}/api/auth/oauth/${p}/callback`;

export const canLogin = (r: ProviderRow) => !!(r.enabled && r.bound_subject && r.client_id && r.client_secret_enc);

/** Login methods that would remain usable; used to prevent locking the admin out. */
export async function loginMethods(env: Env): Promise<{ password: boolean; sso: Provider[] }> {
  const settings = await getSettings(env, { fresh: true });
  const hasHash = !!(await getInternal(env, 'admin_password_hash'));
  const providers = await listProviders(env);
  return {
    password: settings.password_login_enabled || !hasHash,
    sso: providers.filter(canLogin).map((r) => r.provider),
  };
}

export async function saveProvider(
  env: Env,
  p: Provider,
  patch: { enabled?: boolean; client_id?: string; client_secret?: string; issuer?: string },
): Promise<ProviderRow> {
  const cur = await getProvider(env, p);
  const next = { ...cur };
  if (patch.client_id !== undefined) next.client_id = patch.client_id.trim() || null;
  if (patch.client_secret !== undefined && patch.client_secret !== '') next.client_secret_enc = await encryptString(env.SECRET_KEY, patch.client_secret.trim());
  if (patch.issuer !== undefined) {
    const iss = patch.issuer.trim().replace(/\/+$/, '');
    if (iss && !/^https:\/\/[^/\s]+\/\S*$|^https:\/\/[^/\s]+$/.test(iss)) throw new HttpError(400, 'invalid_issuer', 'Issuer must be an https URL');
    next.issuer = iss || null;
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
  // A subject is only meaningful for a given client/issuer.
  if (next.client_id !== cur.client_id || next.issuer !== cur.issuer) {
    next.bound_subject = null;
    next.bound_display = null;
    next.bound_at = null;
  }
  if (next.enabled && (!next.client_id || !next.client_secret_enc || (p === 'cloudflare' && !next.issuer))) {
    throw new HttpError(400, 'sso_incomplete', 'Fill in the client ID and secret (and issuer for Cloudflare) before enabling');
  }
  next.updated_at = now();
  await env.DB.prepare(
    `INSERT INTO sso_providers (provider, enabled, client_id, client_secret_enc, issuer, bound_subject, bound_display, bound_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc,
       issuer = excluded.issuer, bound_subject = excluded.bound_subject, bound_display = excluded.bound_display, bound_at = excluded.bound_at, updated_at = excluded.updated_at`,
  )
    .bind(p, next.enabled, next.client_id, next.client_secret_enc, next.issuer, next.bound_subject, next.bound_display, next.bound_at, next.updated_at)
    .run();
  return next;
}

export async function setBinding(env: Env, p: Provider, subject: string | null, display: string | null): Promise<void> {
  await env.DB.prepare('UPDATE sso_providers SET bound_subject = ?, bound_display = ?, bound_at = ?, updated_at = ? WHERE provider = ?')
    .bind(subject, display, subject ? now() : null, now(), p)
    .run();
}

// ---------- flow ----------

export type Purpose = 'login' | 'bind';

export async function startUrl(env: Env, ref: URL, p: Provider, purpose: Purpose, redirectTo: string): Promise<string> {
  const row = await getProvider(env, p);
  if (!row.client_id || !row.client_secret_enc) throw new HttpError(400, 'sso_not_configured', `${PROVIDER_NAMES[p]} is not configured`);
  if (purpose === 'login' && !canLogin(row)) throw new HttpError(403, 'sso_unavailable', `${PROVIDER_NAMES[p]} sign-in is not enabled`);
  const ep = await endpoints(row);

  const state = randomToken(24);
  const verifier = randomToken(32);
  const challenge = b64url(await sha256(verifier));
  const nonce = ep.oidc ? randomToken(16) : null;
  await env.DB.prepare('INSERT INTO oauth_states (state, provider, purpose, code_verifier, nonce, redirect_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(state, p, purpose, verifier, nonce, safeRelativePath(redirectTo), now() + 600)
    .run();

  const u = new URL(ep.authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', row.client_id);
  u.searchParams.set('redirect_uri', callbackUrl(env, ref, p));
  u.searchParams.set('scope', ep.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (nonce) u.searchParams.set('nonce', nonce);
  if (p === 'google') u.searchParams.set('prompt', 'select_account');
  if (p === 'github') u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

interface StateRow {
  state: string;
  provider: string;
  purpose: Purpose;
  code_verifier: string;
  nonce: string | null;
  redirect_to: string | null;
  expires_at: number;
}

export interface CallbackResult {
  purpose: Purpose;
  redirectTo: string;
  subject: string;
  display: string;
}

export async function handleCallback(env: Env, ref: URL, p: Provider): Promise<CallbackResult> {
  const state = ref.searchParams.get('state');
  const code = ref.searchParams.get('code');
  if (!state) throw new HttpError(400, 'sso_state', 'Missing state');
  // One-time use: delete and return in one statement.
  const st = await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING *').bind(state).first<StateRow>();
  if (!st || st.provider !== p || st.expires_at < now()) throw new HttpError(400, 'sso_state', 'Sign-in session expired, try again');
  const base = { purpose: st.purpose, redirectTo: st.redirect_to ?? '/' };
  // From here on every failure carries the purpose, so a failed *bind* lands back in Settings (not the login
  // page), and unexpected errors (network, bad JSON from a provider) become a clean sso_failed redirect.
  try {
    return await finishCallback(env, ref, p, st, base, code);
  } catch (e) {
    if (e instanceof HttpError) throw Object.assign(e, base);
    throw Object.assign(new HttpError(502, 'sso_failed', e instanceof Error ? e.message : 'Sign-in failed'), base);
  }
}

async function finishCallback(env: Env, ref: URL, p: Provider, st: StateRow, base: { purpose: Purpose; redirectTo: string }, code: string | null): Promise<CallbackResult> {
  const providerError = ref.searchParams.get('error');
  if (providerError) throw Object.assign(new HttpError(400, 'sso_denied', providerError), base);
  if (!code) throw Object.assign(new HttpError(400, 'sso_code', 'Missing authorization code'), base);

  const row = await getProvider(env, p);
  const secret = await decryptString(env.SECRET_KEY, row.client_secret_enc);
  if (!row.client_id || !secret) throw new HttpError(400, 'sso_not_configured', `${PROVIDER_NAMES[p]} is not configured`);
  const ep = await endpoints(row);

  const tokenRes = await fetch(ep.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(env, ref, p),
      client_id: row.client_id,
      client_secret: secret,
      code_verifier: st.code_verifier,
    }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!tokenRes.ok || tok.error) throw Object.assign(new HttpError(400, 'sso_token', tok.error_description ?? tok.error ?? `Token exchange failed (${tokenRes.status})`), base);

  if (ep.oidc) {
    if (!tok.id_token) throw Object.assign(new HttpError(400, 'sso_token', 'No ID token returned'), base);
    const claims = await verifyIdToken(tok.id_token, { ...ep.oidc, audience: row.client_id, nonce: st.nonce ?? undefined }).catch((e: Error) => {
      throw Object.assign(new HttpError(400, 'sso_token', e.message), base);
    });
    if (p === 'google' && !(claims.email_verified === true || claims.email_verified === 'true')) {
      throw Object.assign(new HttpError(400, 'sso_unverified', 'Google account email is not verified'), base);
    }
    return { ...base, subject: claims.sub, display: claims.email ?? claims.name ?? claims.sub };
  }

  // GitHub: fetch the user; the numeric id is stable across renames.
  const userRes = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'artifacts-share' },
  });
  if (!userRes.ok) throw Object.assign(new HttpError(400, 'sso_user', `GitHub user lookup failed (${userRes.status})`), base);
  const user = (await userRes.json()) as { id: number; login: string };
  return { ...base, subject: String(user.id), display: user.login };
}
