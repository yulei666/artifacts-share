import { b64urlDecode } from './crypto';

const dec = new TextDecoder();
const enc = new TextEncoder();

interface Jwk extends JsonWebKey { kid?: string }
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function getJwks(uri: string, force = false): Promise<Jwk[]> {
  const hit = jwksCache.get(uri);
  if (!force && hit && Date.now() - hit.at < 3600_000) return hit.keys;
  const res = await fetch(uri, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache.set(uri, { at: Date.now(), keys });
  return keys;
}

const ALGS: Record<string, { import: SubtleCryptoImportKeyAlgorithm; verify: SubtleCryptoSignAlgorithm | string }> = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: 'RSASSA-PKCS1-v1_5' },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
};

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  [k: string]: unknown;
}

/** Verifies an OIDC ID token's signature (JWKS) and standard claims. */
export async function verifyIdToken(token: string, opts: { jwksUri: string; issuer: string | string[]; audience: string; nonce?: string }): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  const header = JSON.parse(dec.decode(b64urlDecode(parts[0]))) as { alg: string; kid?: string };
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`Unsupported ID token alg: ${header.alg}`);

  let keys = await getJwks(opts.jwksUri);
  let jwk = keys.find((k) => k.kid === header.kid) ?? (header.kid ? undefined : keys[0]);
  if (!jwk) {
    keys = await getJwks(opts.jwksUri, true); // key rotation
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('Signing key not found');
  const key = await crypto.subtle.importKey('jwk', jwk, alg.import, false, ['verify']);
  const ok = await crypto.subtle.verify(alg.verify, key, b64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('Invalid ID token signature');

  const claims = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as IdTokenClaims;
  const t = Math.floor(Date.now() / 1000);
  if (!(Array.isArray(opts.issuer) ? opts.issuer : [opts.issuer]).includes(claims.iss)) throw new Error('ID token issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) throw new Error('ID token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp + 60 < t) throw new Error('ID token expired');
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce) throw new Error('ID token nonce mismatch');
  if (!claims.sub) throw new Error('ID token has no subject');
  return claims;
}
