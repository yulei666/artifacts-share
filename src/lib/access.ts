import type { ArtifactRow, Env } from '../env';
import { decryptString, timingSafeEqualStr } from './crypto';
import { clientIp } from './http';
import { peekAttempts, refundAttempt, retryAfter, takeAttempt } from './ratelimit';
import { CAPTCHA_AFTER_FAILS, maxAttempts, turnstileEnabled, verifyTurnstile } from './turnstile';

export type AttemptResult =
  | { ok: true }
  | { ok: false; reason: 'incorrect'; remaining: number }
  | { ok: false; reason: 'locked'; retryAfter: number }
  | { ok: false; reason: 'turnstile' };

/** Turnstile is required once a bucket has a few failures (and Turnstile is configured). */
export async function captchaRequiredFor(env: Env, bucket: string): Promise<boolean> {
  return turnstileEnabled(env) && (await peekAttempts(env, bucket)).fails >= CAPTCHA_AFTER_FAILS;
}

/**
 * The one guarded-attempt flow shared by admin login and access codes:
 *   Turnstile (when required; a failed check is not counted) → count the attempt atomically →
 *   run `check` → a success gives the attempt back (only failures count).
 * If `check` throws, the attempt stays counted.
 */
export async function guardedAttempt(env: Env, req: Request, bucket: string, turnstileToken: string | null | undefined, check: () => Promise<boolean>): Promise<AttemptResult> {
  if (await captchaRequiredFor(env, bucket)) {
    if (!(await verifyTurnstile(env, turnstileToken ?? '', clientIp(req)))) return { ok: false, reason: 'turnstile' };
  }
  const max = maxAttempts(env);
  const att = await takeAttempt(env, bucket, max);
  if (att.limited) return { ok: false, reason: 'locked', retryAfter: retryAfter(att) };
  if (await check()) {
    await refundAttempt(env, bucket, att.resetAt);
    return { ok: true };
  }
  const remaining = max - att.fails;
  return remaining > 0 ? { ok: false, reason: 'incorrect', remaining } : { ok: false, reason: 'locked', retryAfter: retryAfter(att) };
}

/** One counter per artifact + IP, shared by the unlock page, `?pwd=` links and the download popover. */
const unlockBucket = (req: Request, a: ArtifactRow) => `unlock:${a.id}:${clientIp(req)}`;
export const loginBucket = (req: Request) => `login:${clientIp(req)}`;

export function captchaRequired(env: Env, req: Request, a: ArtifactRow): Promise<boolean> {
  return captchaRequiredFor(env, unlockBucket(req, a));
}

/** Checks an artifact's access code through {@link guardedAttempt}. */
export function verifyAccessCode(env: Env, req: Request, a: ArtifactRow, code: string, turnstileToken?: string | null): Promise<AttemptResult> {
  return guardedAttempt(env, req, unlockBucket(req, a), turnstileToken, async () => {
    const expected = await decryptString(env.SECRET_KEY, a.password_enc);
    return !!expected && timingSafeEqualStr(code.trim().toUpperCase(), expected);
  });
}
