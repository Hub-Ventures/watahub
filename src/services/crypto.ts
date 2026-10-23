/**
 * Cryptographic helpers using Web Standards (crypto.subtle)
 * Fully compatible with Cloudflare Workers, Node.js and Bun.
 */

const encoder = new TextEncoder()

const SIGNATURE_PREFIX = 'sha256='

/** HMAC-SHA256 digests are exactly 32 bytes (64 hex chars) */
const SHA256_HEX = /^[0-9a-fA-F]{64}$/

function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

/**
 * Verifies Meta's X-Hub-Signature-256 header.
 * Meta computes: sha256=HMAC_SHA256(rawBody, appSecret)
 */
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader || !appSecret) return false
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false

  const expectedSigHex = signatureHeader.slice(SIGNATURE_PREFIX.length).trim()
  // Reject anything that is not a full digest before touching crypto
  if (!SHA256_HEX.test(expectedSigHex)) return false

  const cryptoKey = await importHmacKey(appSecret, 'verify')
  // crypto.subtle.verify compares in constant time
  return crypto.subtle.verify('HMAC', cryptoKey, hexToBytes(expectedSigHex), encoder.encode(rawBody))
}

/**
 * Signs payload for subscriber webhook delivery with HMAC-SHA256.
 * Generates: sha256=<hex_digest>
 */
export async function signSubscriberPayload(payloadString: string, secret: string): Promise<string> {
  const cryptoKey = await importHmacKey(secret, 'sign')
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payloadString))
  return SIGNATURE_PREFIX + bytesToHex(new Uint8Array(signature))
}

/**
 * Constant-time string comparison for secrets (API keys, verify tokens).
 * Both inputs are hashed first so the comparison never short-circuits on
 * length or on the first differing character.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < digestA.length; i++) {
    diff |= digestA[i] ^ digestB[i]
  }
  return diff === 0
}

/**
 * Hex-encoded SHA-256 digest. Used to derive stable idempotency keys.
 */
export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await sha256(input))
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)))
}

/** Callers only pass strings that already matched SHA256_HEX */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
