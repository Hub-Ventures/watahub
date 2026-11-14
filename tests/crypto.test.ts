import { describe, it, expect } from 'vitest'
import { verifyMetaSignature, signSubscriberPayload, verifySubscriberSignature } from '../src/services/crypto.js'

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

  describe('verifySubscriberSignature', () => {
    it('accepts what signSubscriberPayload produced for the same body and secret', async () => {
      const header = await signSubscriberPayload(payload, secret)
      expect(await verifySubscriberSignature(payload, header, secret)).toBe(true)
      // The digest is compared as bytes, so its hex case does not matter
      const upperCased = `sha256=${header.slice('sha256='.length).toUpperCase()}`
      expect(await verifySubscriberSignature(payload, upperCased, secret)).toBe(true)
    })

    it('rejects a wrong secret, a tampered body and a re-serialized body', async () => {
      const header = await signSubscriberPayload(payload, secret)
      expect(await verifySubscriberSignature(payload, header, 'wrong-secret')).toBe(false)
      expect(await verifySubscriberSignature(payload.replace('42', '43'), header, secret)).toBe(false)
      const reserialized = JSON.stringify(JSON.parse(payload), null, 2)
      expect(await verifySubscriberSignature(reserialized, header, secret)).toBe(false)
    })

    it('rejects a missing, malformed or truncated header and an empty secret', async () => {
      const header = await signSubscriberPayload(payload, secret)
      const digest = header.slice('sha256='.length)
      expect(await verifySubscriberSignature(payload, null, secret)).toBe(false)
      expect(await verifySubscriberSignature(payload, undefined, secret)).toBe(false)
      expect(await verifySubscriberSignature(payload, '', secret)).toBe(false)
      expect(await verifySubscriberSignature(payload, digest, secret)).toBe(false)
      expect(await verifySubscriberSignature(payload, `sha1=${digest}`, secret)).toBe(false)
      expect(await verifySubscriberSignature(payload, header.slice(0, -2), secret)).toBe(false)
      expect(await verifySubscriberSignature(payload, `sha256=${'z'.repeat(64)}`, secret)).toBe(false)
      expect(await verifySubscriberSignature(payload, header, '')).toBe(false)
    })
  })
})
