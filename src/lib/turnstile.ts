import type { Env } from '../env';

/** Failed logins (per IP, per rate-limit window) after which the login form requires Turnstile. */
export const CAPTCHA_AFTER_FAILS = 3;
/**
 * Hard lockout per window (login and access codes): higher with Turnstile, since solving it is already a
 * gate — otherwise the CAPTCHA would only buy two extra attempts.
 */
export const maxAttempts = (env: Env) => (turnstileEnabled(env) ? 10 : 5);

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileEnabled(env: Env): boolean {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

/** Server-side Turnstile check (tokens are single-use and expire after 5 minutes). */
export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY!);
  body.append('response', token);
  if (ip && ip !== 'unknown') body.append('remoteip', ip);
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false; // fail closed
  }
}
