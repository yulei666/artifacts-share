const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Access codes: uppercase letters + digits without look-alikes (0/O, 1/I/L).
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Uniform random string over `alphabet` (rejection sampling, no modulo bias). */
export function randomString(len: number, alphabet: string): string {
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < len) {
    for (const byte of randomBytes(len * 2)) {
      if (byte < max) out += alphabet[byte % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}

export const randomBase62 = (len: number) => randomString(len, BASE62);
export const randomAccessCode = () => randomString(6, CODE_ALPHABET);

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const buf = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

export async function sha256Hex(data: string): Promise<string> {
  return [...(await sha256(data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ---- Key derivation from SECRET_KEY ----

interface Keys {
  sign: CryptoKey;
  enc: CryptoKey;
}
let keyCache: { secret: string; keys: Promise<Keys> } | null = null;

export function getKeys(secret: string): Promise<Keys> {
  if (!secret || secret.length < 16) throw new Error('SECRET_KEY is missing or too short');
  if (keyCache?.secret === secret) return keyCache.keys;
  const keys = (async () => {
    const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('artifacts-share'), info: enc.encode(info) });
    const sign = await crypto.subtle.deriveKey(hkdf('sign'), ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    const encKey = await crypto.subtle.deriveKey(hkdf('enc'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { sign, enc: encKey };
  })();
  keyCache = { secret, keys };
  // Don't pin a failed derivation for the isolate's lifetime: the next call retries.
  keys.catch(() => {
    if (keyCache?.keys === keys) keyCache = null;
  });
  return keys;
}

/** Signs a JSON payload: `base64url(json).base64url(hmac)`. */
export async function signPayload(secret: string, payload: object): Promise<string> {
  const { sign } = await getKeys(secret);
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', sign, enc.encode(body));
  return `${body}.${b64url(mac)}`;
}

export async function verifyPayload<T = Record<string, unknown>>(secret: string, token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  try {
    const { sign } = await getKeys(secret);
    const ok = await crypto.subtle.verify('HMAC', sign, b64urlDecode(token.slice(dot + 1)), enc.encode(body));
    if (!ok) return null;
    return JSON.parse(dec.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

export async function encryptString(secret: string, plain: string): Promise<string> {
  const { enc: key } = await getKeys(secret);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

export async function decryptString(secret: string, data: string | null | undefined): Promise<string | null> {
  if (!data) return null;
  try {
    const { enc: key } = await getKeys(secret);
    const raw = b64urlDecode(data);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// ---- Password hashing (PBKDF2; Workers caps iterations at 100k) ----

const PBKDF2_ITER = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split('$');
  if (alg !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const actual = await pbkdf2(password, b64urlDecode(salt), Number(iter));
  return timingSafeEqualStr(b64url(actual), hash);
}
