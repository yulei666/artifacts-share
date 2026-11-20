import type { Env } from '../env';
import { now } from './http';

// Admin-session liveness for content-host owner checks, cached briefly per isolate: an owner previewing a
// page with many assets would otherwise cost one D1 lookup per subresource. Sign-out clears the entry here;
// other isolates notice within CACHE_MS.
const CACHE_MS = 10_000;
const cache = new Map<string, { alive: boolean; at: number }>();

export async function sessionAlive(env: Env, sid: string): Promise<boolean> {
  const hit = cache.get(sid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.alive;
  const alive = !!(await env.DB.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?').bind(sid, now()).first());
  if (cache.size > 1000) cache.clear();
  cache.set(sid, { alive, at: Date.now() });
  return alive;
}

/** Drop one session (sign-out) or all of them (sign out everywhere) from this isolate's cache. */
export function forgetSessions(sid?: string): void {
  if (sid) cache.delete(sid);
  else cache.clear();
}
