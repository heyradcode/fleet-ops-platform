/**
 * ---------------------------------------------------------------------------
 * Hashing and id generation, without `node:crypto`
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, and it is not "to avoid a dependency":
 *
 * The whole platform runs in two places. On AWS it is a Lambda. In the demo it
 * also runs *inside the browser* - the dispatch board imports the resolvers
 * directly, because `src/aws/` is already a set of local stand-ins. There is no
 * server in the middle.
 *
 * `node:crypto` does not exist in a browser, and the browser's replacement
 * (`crypto.subtle.digest`) is ASYNC ONLY. That matters more than it sounds:
 *
 *     telemetryId = sha256(provider | sourceRef | observedAt)
 *
 * is computed on the synchronous normalisation path, inside a `.map()`. Making
 * it async would turn every function between the connector and the repository
 * into an async function, for no benefit whatsoever. So: a synchronous SHA-256,
 * implemented here, identical output on both runtimes.
 *
 * It is ~60 lines and it is the real algorithm, not a stand-in. Content-hash
 * idempotency is one of this codebase's load-bearing arguments; demonstrating it
 * with a weaker hash would undercut the point.
 *
 * (`crypto.randomUUID()` needs no such treatment - Node 19+ and every browser in
 * a secure context both have it on the global `crypto` object.)
 */

// SHA-256 round constants: the first 32 bits of the fractional parts of the
// cube roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** Synchronous SHA-256 over raw bytes. The core; everything else wraps it. */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {

  // Pad: append 0x80, then zeros, until length ≡ 56 (mod 64), then a 64-bit
  // big-endian bit count.
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(new ArrayBuffer((((bytes.length + 8) >> 6) + 1) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // Bit length is written as 64 bits; this codebase never hashes >512MB, so the
  // high word is always zero and only the low 32 bits are meaningful.
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const w = new Uint32Array(64);
  const view = new DataView(padded.buffer);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, h[0], false);
  for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(i * 4, h[i], false);
  return out;
}

/**
 * A random UUID.
 *
 * Deliberately NOT used for anything that must be idempotent - see `ids.ts` for
 * why telemetry ids are content hashes instead.
 *
 * Injectable for the same reason as the clock: without it, every demo run
 * produces different incident ids and S3 keys, so two runs cannot be diffed.
 * The default is `crypto.randomUUID()` and stays that way in production - the
 * demo installs a seeded generator, and nothing security-sensitive draws here.
 */
export type UuidFn = () => string;

/**
 * A real random UUID, with a fallback that matters more than it looks.
 *
 * `crypto.randomUUID()` is only available in a SECURE CONTEXT: https, or
 * localhost. Serve the same page over plain http on a LAN address - which is
 * what happens behind a VPN that intercepts loopback, or when you open the
 * board from a phone on the same network - and it is simply `undefined`. The
 * page then dies on the first id it needs, with a TypeError that says nothing
 * about the actual cause.
 *
 * `crypto.getRandomValues` carries no such restriction, so the fallback is a
 * hand-assembled v4: same randomness source, same shape, no secure-context
 * requirement.
 */
const cryptoUuid: UuidFn = () => {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant 10xx

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20),
  ].join('-');
};
let currentUuid: UuidFn = cryptoUuid;

export function setUuid(fn: UuidFn): void { currentUuid = fn; }

export function uuid(): string { return currentUuid(); }

/**
 * A v4-shaped UUID drawn from an injected random source.
 *
 * Shaped like a real UUID (version and variant nibbles set) so that anything
 * parsing it still works; NOT cryptographically random, and never used where
 * that matters.
 */
export function seededUuid(random: () => number): UuidFn {
  return () => {
    const hex = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
      if (i === 14) { out += '4'; continue; }
      const n = Math.floor(random() * 16);
      out += i === 19 ? hex[(n & 0x3) | 0x8] : hex[n];
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Portable encodings. `Buffer` is Node-only, so these replace it.
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Synchronous SHA-256 of a UTF-8 string. Returns lowercase hex. */
export function sha256(input: string): string {
  return toHex(sha256Bytes(utf8.encode(input)));
}

/**
 * HMAC-SHA256, per RFC 2104.
 *
 * Used only to sign the demo's stand-in JWTs. Real Cognito tokens are RS256 and
 * verified against the pool's public JWKS - see cognito-jwt-verifier.ts, which
 * explains the difference and why it matters.
 */
export function hmacSha256(key: string, message: string): Uint8Array {
  const BLOCK = 64;
  let k: Uint8Array<ArrayBufferLike> = utf8.encode(key);
  if (k.length > BLOCK) k = sha256Bytes(k);

  const inner = new Uint8Array(BLOCK);
  const outer = new Uint8Array(BLOCK);
  inner.set(k);
  outer.set(k);
  for (let i = 0; i < BLOCK; i++) {
    inner[i] ^= 0x36;
    outer[i] ^= 0x5c;
  }

  const msg = utf8.encode(message);
  const innerInput = new Uint8Array(BLOCK + msg.length);
  innerInput.set(inner);
  innerInput.set(msg, BLOCK);
  const innerHash = sha256Bytes(innerInput);

  const outerInput = new Uint8Array(BLOCK + innerHash.length);
  outerInput.set(outer);
  outerInput.set(innerHash, BLOCK);
  return sha256Bytes(outerInput);
}

/**
 * Constant-time comparison. Replaces `node:crypto`'s timingSafeEqual.
 *
 * `===` on a signature leaks how many leading bytes matched via how long the
 * comparison took, which is enough to forge one byte at a time. Accumulating
 * the XOR means the loop always runs to the end.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** base64url encode. Accepts bytes or a UTF-8 string. */
export function b64urlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? utf8.encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url decode to bytes. */
export function b64urlDecode(s: string): Uint8Array {
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url decode to a UTF-8 string. */
export function b64urlDecodeText(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s));
}
