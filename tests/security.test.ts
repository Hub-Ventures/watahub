import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from '../src/index.js'
import { signSubscriberPayload, timingSafeEqual, verifyMetaSignature } from '../src/services/crypto.js'

const APP_SECRET = 'meta-app-secret-for-tests'

const metaPayload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1234',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: '987654' },
            contacts: [{ wa_id: '573001234567', profile: { name: 'Test' } }],
            messages: [
              { from: '573001234567', id: 'wamid.TEST', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
            ],
          },
        },
      ],
    },
  ],
})

async function postWebhook(body: string, signature?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (signature) headers['x-hub-signature-256'] = signature
  return app.request('/webhook', { method: 'POST', headers, body })
}

describe('Webhook signature enforcement', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('rejects deliveries with 503 when META_APP_SECRET is not configured (fail closed)', async () => {
    delete process.env.META_APP_SECRET
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await postWebhook(metaPayload)
    expect(res.status).toBe(503)
  })

  it('rejects unsigned deliveries when META_APP_SECRET is configured', async () => {
    process.env.META_APP_SECRET = APP_SECRET
    const res = await postWebhook(metaPayload)
    expect(res.status).toBe(401)
  })

  it('accepts deliveries signed over the exact raw body', async () => {
    process.env.META_APP_SECRET = APP_SECRET
    const signature = await signSubscriberPayload(metaPayload, APP_SECRET)
    const res = await postWebhook(metaPayload, signature)
    expect(res.status).toBe(200)
  })

  it('rejects a valid signature when the body was re-serialized (whitespace change)', async () => {
    process.env.META_APP_SECRET = APP_SECRET
    const signature = await signSubscriberPayload(metaPayload, APP_SECRET)
    const reformatted = JSON.stringify(JSON.parse(metaPayload), null, 2)
    const res = await postWebhook(reformatted, signature)
    expect(res.status).toBe(401)
  })

  it('rejects signatures that are not exactly 64 hex characters', async () => {
    const valid = await signSubscriberPayload(metaPayload, APP_SECRET)
    // Truncated digests and digests with junk characters must not verify
    expect(await verifyMetaSignature(metaPayload, valid.slice(0, 40), APP_SECRET)).toBe(false)
    expect(await verifyMetaSignature(metaPayload, `${valid}zz`, APP_SECRET)).toBe(false)
    expect(await verifyMetaSignature(metaPayload, valid.replace('sha256=', 'sha256=--'), APP_SECRET)).toBe(false)
  })
})

describe('timingSafeEqual', () => {
  it('returns true only for identical strings', async () => {
    expect(await timingSafeEqual('abc', 'abc')).toBe(true)
    expect(await timingSafeEqual('abc', 'abd')).toBe(false)
    expect(await timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(await timingSafeEqual('', 'a')).toBe(false)
  })
})
