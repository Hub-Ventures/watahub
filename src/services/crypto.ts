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
  if (!expectedSigHex) return false

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
