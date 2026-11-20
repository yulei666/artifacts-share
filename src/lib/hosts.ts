import type { Env } from '../env';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID_RE = new RegExp(`^${UUID}$`);
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID_RE.test(s);
const DEFAULT_SUFFIX = '-share';

export type HostKind = { kind: 'main' } | { kind: 'content'; id: string } | { kind: 'unknown' };

export function hostname(req: Request): string {
  return new URL(req.url).hostname.toLowerCase();
}

/**
 * Subdomain suffix after the uuid. Must be a valid DNS label tail (letters, digits, hyphens)
 * and keep the label within 63 chars; an empty string means `{uuid}.{zone}`.
 */
export function hostSuffix(env: Env): string {
  const s = (env.CONTENT_HOST_SUFFIX ?? DEFAULT_SUFFIX).toLowerCase();
  if (!/^[a-z0-9-]{0,27}$/.test(s) || s.endsWith('-')) throw new Error(`Invalid CONTENT_HOST_SUFFIX: "${s}"`);
  return s;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compiled once per (suffix, zone) — this runs on every request.
let hostRe: { key: string; re: RegExp } | null = null;
function contentHostRe(env: Env): RegExp {
  const key = `${hostSuffix(env)}|${env.CONTENT_ZONE.toLowerCase()}`;
  if (hostRe?.key !== key) {
    hostRe = { key, re: new RegExp(`^(${UUID})${escapeRe(hostSuffix(env))}\\.${escapeRe(env.CONTENT_ZONE.toLowerCase())}$`) };
  }
  return hostRe.re;
}

export function classifyHost(env: Env, host: string): HostKind {
  host = host.toLowerCase();
  if (host === env.MAIN_HOST.toLowerCase()) return { kind: 'main' };
  const m = contentHostRe(env).exec(host);
  if (m) return { kind: 'content', id: m[1] };
  return { kind: 'unknown' };
}

/** Origin of an artifact's content host, reusing the scheme/port of `ref` (handy for local dev). */
export function contentOrigin(env: Env, publicId: string, ref: URL): string {
  const port = ref.port ? `:${ref.port}` : '';
  return `${ref.protocol}//${publicId}${hostSuffix(env)}.${env.CONTENT_ZONE.toLowerCase()}${port}`;
}

export function mainOrigin(env: Env, ref: URL): string {
  const port = ref.port ? `:${ref.port}` : '';
  // Lowercase: browsers send Origin lowercased, and the CSRF check compares against this.
  return `${ref.protocol}//${env.MAIN_HOST.toLowerCase()}${port}`;
}
