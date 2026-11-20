/** API error. `details` adds structured fields to the error body (e.g. `remaining`, `retry_after`). */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export function jsonError(status: number, code: string, message?: string, details?: Record<string, unknown>): Response {
  const res = Response.json({ error: { ...details, code, message: message ?? code } }, { status });
  if (typeof details?.retry_after === 'number') res.headers.set('retry-after', String(details.retry_after));
  return res;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    const raw = part.slice(i + 1).trim();
    // A malformed value (anyone on the content zone can set one) must not break every request.
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}

/**
 * `__Host-` cookie: Secure, host-only, Path=/.
 * `embedded` cookies are for the content host, which is shown in an iframe on the (cross-site) main
 * domain: SameSite=None so the iframe gets them, Partitioned (CHIPS) so they are keyed by the top-level
 * site — a third-party page framing the artifact gets its own, empty cookie jar.
 */
export function hostCookie(name: string, value: string, maxAge: number, opts: { embedded?: boolean } = {}): string {
  const site = opts.embedded ? 'SameSite=None; Partitioned' : 'SameSite=Lax';
  return `__Host-${name}=${encodeURIComponent(value)}; Path=/; Secure; HttpOnly; ${site}; Max-Age=${maxAge}`;
}

export function clearHostCookie(name: string, opts: { embedded?: boolean } = {}): string {
  return hostCookie(name, '', 0, opts);
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
}

export const now = () => Math.floor(Date.now() / 1000);

const BASE = 'https://base.invalid';

/**
 * Only allows same-origin relative paths like "/foo?x=1". Browsers drop tabs/newlines and treat "\\"
 * as "/", so "/\t/evil.com" or "/\\evil.com" would become protocol-relative; reject those and re-serialize
 * through the URL parser so what we emit is exactly what the browser will follow.
 */
export function safeRelativePath(p: string | null | undefined, fallback = '/'): string {
  if (!p || !p.startsWith('/') || /[\x00-\x20\x7f\\]/.test(p)) return fallback;
  try {
    const u = new URL(p, BASE);
    if (u.origin !== BASE) return fallback;
    // Dot segments are resolved by the parser: '/.//evil.com' or '/a/..//x' normalize to '//evil.com',
    // which a browser reads as another host. Judge the *output*, not just the input.
    if (u.pathname.startsWith('//')) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** Collapses leading slashes so a request path like "//evil.com" can't become a protocol-relative Location. */
export const localPath = (pathname: string) => '/' + pathname.replace(/^\/+/, '');

/**
 * Reads a request body into memory, failing with 413 as soon as it exceeds `max` bytes (no unbounded
 * buffering of a chunked body — the isolate has 128 MB).
 */
export async function readBodyLimited(req: Request, max: number, code = 'file_too_large'): Promise<Uint8Array> {
  const declared = req.headers.get('content-length');
  if (declared !== null && Number(declared) > max) throw new HttpError(413, code, `Body exceeds ${max} bytes`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  // Resize a single buffer as chunks arrive. Keeping chunks and assembling a second full copy
  // would use twice the upload limit in memory.
  const buffer = new ArrayBuffer(Math.min(64 * 1024, max), { maxByteLength: max });
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const end = total + value.byteLength;
      if (end > max) {
        await reader.cancel();
        throw new HttpError(413, code, `Body exceeds ${max} bytes`);
      }
      if (end > buffer.byteLength) buffer.resize(Math.min(max, Math.max(end, buffer.byteLength * 2)));
      new Uint8Array(buffer, total, value.byteLength).set(value);
      total = end;
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(buffer.transferToFixedLength(total));
}

/**
 * Request body as a JSON object. Malformed JSON, or JSON that isn't an object (`null`, arrays, numbers), is a
 * 400 `invalid_json`. `optional`: an empty body reads as `{}` (for endpoints whose body is all-optional).
 */
export async function readJsonObject<T = Record<string, unknown>>(req: Request, opts: { optional?: boolean; maxBytes?: number } = {}): Promise<T> {
  const text = new TextDecoder().decode(await readBodyLimited(req, opts.maxBytes ?? 1024 * 1024, 'request_too_large'));
  if (!text.trim() && opts.optional) return {} as T;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
  return body as T;
}
