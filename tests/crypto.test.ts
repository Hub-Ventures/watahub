import { describe, it, expect } from 'vitest'
import { verifyMetaSignature, signSubscriberPayload } from '../src/services/crypto.js'

describe('Crypto Services', () => {
  const secret = 'super-secret-test-key-123'
  const payload = JSON.stringify({ message: 'hello world', count: 42 })

  it('generates a valid subscriber signature and verifies it with HMAC-SHA256', async () => {
    const signatureHeader = await signSubscriberPayload(payload, secret)

    expect(signatureHeader).toMatch(/^sha256=[0-9a-f]{64}$/)

    // Meta signature verification uses the exact same algorithm
    const isValid = await verifyMetaSignature(payload, signatureHeader, secret)
    expect(isValid).toBe(true)
  })

  it('rejects signature with wrong secret', async () => {
    const signatureHeader = await signSubscriberPayload(payload, secret)
    const isValid = await verifyMetaSignature(payload, signatureHeader, 'wrong-secret')
    expect(isValid).toBe(false)
  })

  it('rejects signature with tampered body', async () => {
    const signatureHeader = await signSubscriberPayload(payload, secret)
    const tamperedPayload = JSON.stringify({ message: 'hello hacked', count: 42 })
    const isValid = await verifyMetaSignature(tamperedPayload, signatureHeader, secret)
    expect(isValid).toBe(false)
  })

  it('rejects malformed or missing signature header', async () => {
    expect(await verifyMetaSignature(payload, null, secret)).toBe(false)
    expect(await verifyMetaSignature(payload, '', secret)).toBe(false)
    expect(await verifyMetaSignature(payload, 'not-a-sha256-sig', secret)).toBe(false)
  })
})
