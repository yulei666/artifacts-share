import type { Env } from '../env';
import { now } from './http';

/** A window starts at the first failure and lasts this long (not wall-clock slots). */
export const WINDOW_SEC = 600;
export const MAX_FAILS = 5;

export interface AttemptState {
  fails: number;
  /** Unix seconds when the window ends (0 when there is no open window). */
  resetAt: number;
}

export interface Attempt extends AttemptState {
  /** Over the limit: reject this attempt. */
  limited: boolean;
}

/**
 * Counts an attempt *before* it is checked, in one atomic upsert (parallel requests can't all slip past a
 * read-then-write check). An expired window restarts at 1, so the 10 minutes run from the first failure.
 * Successful attempts give their slot back with {@link refundAttempt}, so only failures count.
 */
export async function takeAttempt(env: Env, bucket: string, max = MAX_FAILS): Promise<Attempt> {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, fails, reset_at) VALUES (?1, 1, ?2 + ?3)
     ON CONFLICT(bucket) DO UPDATE SET
       fails    = CASE WHEN reset_at <= ?2 THEN 1 ELSE fails + 1 END,
       reset_at = CASE WHEN reset_at <= ?2 THEN ?2 + ?3 ELSE reset_at END
     RETURNING fails, reset_at`,
  )
    .bind(bucket, t, WINDOW_SEC)
    .first<{ fails: number; reset_at: number }>();
  const fails = row?.fails ?? 1;
  return { fails, resetAt: row?.reset_at ?? t + WINDOW_SEC, limited: fails > max };
}

/** Current failures in the open window (read-only). */
export async function peekAttempts(env: Env, bucket: string): Promise<AttemptState> {
  const row = await env.DB.prepare('SELECT fails, reset_at FROM rate_limits WHERE bucket = ? AND reset_at > ?').bind(bucket, now()).first<{ fails: number; reset_at: number }>();
  return row ? { fails: row.fails, resetAt: row.reset_at } : { fails: 0, resetAt: 0 };
}

export async function refundAttempt(env: Env, bucket: string): Promise<void> {
  await env.DB.prepare('UPDATE rate_limits SET fails = MAX(fails - 1, 0) WHERE bucket = ? AND reset_at > ?').bind(bucket, now()).run();
}

/** Seconds until the window ends (at least 1). */
export const retryAfter = (s: AttemptState) => Math.max(1, s.resetAt - now());

export async function purgeRateLimits(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now()).run();
}
