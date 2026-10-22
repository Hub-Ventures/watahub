/**
 * Cryptographic helpers using Web Standards (crypto.subtle)
 * Fully compatible with Cloudflare Workers, Node.js and Bun.
 */

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

  const prefix = 'sha256='
  if (!signatureHeader.startsWith(prefix)) return false

  const expectedSigHex = signatureHeader.slice(prefix.length).trim()
  // HMAC-SHA256 digests are exactly 32 bytes (64 hex chars); reject anything else up front
  if (!/^[0-9a-fA-F]{64}$/.test(expectedSigHex)) return false

  try {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(appSecret)
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData as unknown as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify', 'sign']
    )

    const signatureBytes = hexToBytes(expectedSigHex)
    const dataBytes = encoder.encode(rawBody)

    return await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      signatureBytes as unknown as BufferSource,
      dataBytes as unknown as BufferSource
    )
  } catch (err) {
    console.error('Error verifying Meta signature:', err)
    return false
  }
}

/**
 * Signs payload for subscriber webhook delivery with HMAC-SHA256.
 * Generates: sha256=<hex_digest>
 */
export async function signSubscriberPayload(
  payloadString: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder()
  const keyData = encoder.encode(secret)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(payloadString) as unknown as BufferSource
  )

  return 'sha256=' + bytesToHex(new Uint8Array(signatureBuffer))
}

/**
 * Constant-time string comparison for secrets (API keys, verify tokens).
 * Both inputs are hashed first so the comparison never short-circuits on
 * length or on the first differing character.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a) as unknown as BufferSource),
    crypto.subtle.digest('SHA-256', encoder.encode(b) as unknown as BufferSource),
  ])
  const bytesA = new Uint8Array(digestA)
  const bytesB = new Uint8Array(digestB)
  let diff = 0
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i]
  }
  return diff === 0
}

/**
 * Hex-encoded SHA-256 digest. Used to derive stable idempotency keys.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input) as unknown as BufferSource
  )
  return bytesToHex(new Uint8Array(digest))
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}
