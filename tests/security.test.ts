import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app, { BODY_LIMITS } from '../src/index.js'
import { signSubscriberPayload, timingSafeEqual, verifyMetaSignature } from '../src/services/crypto.js'
import { redactSecrets } from '../src/utils/redact.js'
import { webhookDeliveryIds } from '../src/services/replay.js'

// Identical signed bodies are deduplicated across requests; every test starts clean
beforeEach(() => webhookDeliveryIds.clear())

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
              { from: '573001234567', id: 'wamid.TEST', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } },
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

describe('Gateway API key enforcement (fail closed)', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  const protectedRequests: Array<[string, RequestInit]> = [
    ['/v1/messages', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }],
    ['/v1/templates/123', { method: 'GET' }],
    ['/v1/onboarding/exchange', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }],
    ['/v1/onboarding/subscribe', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }],
    ['/v1/onboarding/override-callback', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }],
    ['/v24.0/123/messages', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }],
  ]

  it.each(protectedRequests)('%s returns 503 when WATAHUB_API_KEY is unset', async (path, init) => {
    delete process.env.WATAHUB_API_KEY
    process.env.META_SYSTEM_USER_TOKEN = 'EAAG-system-token'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await app.request(path, init)
    expect(res.status).toBe(503)
    // The system user token must never reach Meta for an unauthenticated caller
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(protectedRequests)('%s returns 401 with a wrong key', async (path, init) => {
    process.env.WATAHUB_API_KEY = KEY
    const headers = { ...(init.headers as Record<string, string>), 'X-API-Key': `${KEY}x` }
    const res = await app.request(path, { ...init, headers })
    expect(res.status).toBe(401)
  })

  it('accepts the key via Authorization: Bearer and via X-API-Key', async () => {
    process.env.WATAHUB_API_KEY = KEY
    delete process.env.META_DEFAULT_WABA_ID

    // Past auth, the route fails on its own validation (missing wabaId) → 400
    const viaBearer = await app.request('/v1/templates', { headers: { Authorization: `Bearer ${KEY}` } })
    const viaHeader = await app.request('/v1/templates', { headers: { 'X-API-Key': KEY } })
    expect(viaBearer.status).toBe(400)
    expect(viaHeader.status).toBe(400)
  })

  it('leaves /health and the Meta webhook handshake public', async () => {
    delete process.env.WATAHUB_API_KEY
    expect((await app.request('/health')).status).toBe(200)
  })
})

describe('Input validation keeps caller input out of Graph paths', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'
  const auth = { 'X-API-Key': KEY, 'Content-Type': 'application/json' }

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('rejects a path-traversal wabaId on /v1/templates before calling Meta', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // Decodes to "../../me?fields=id#", which used to resolve to https://graph.facebook.com/me
    const res = await app.request('/v1/templates/..%2F..%2Fme%3Ffields%3Did%23', { headers: auth })
    expect(res.status).toBe(422)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric X-Phone-Number-Id header on /v1/messages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { ...auth, 'X-Phone-Number-Id': '../123456/subscribed_apps' },
      body: JSON.stringify({ to: '573001234567', kind: 'text', text: { body: 'hi' } }),
    })
    expect(res.status).toBe(422)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requires the content object that matches the message kind', async () => {
    const send = (body: unknown) =>
      app.request('/v1/messages', { method: 'POST', headers: auth, body: JSON.stringify(body) })

    expect((await send({ to: '573001234567', phoneNumberId: '123', kind: 'text' })).status).toBe(422)
    expect((await send({ to: '573001234567', phoneNumberId: '123', kind: 'image', media: {} })).status).toBe(422)
    expect((await send({ to: '573001234567', phoneNumberId: '123', kind: 'template' })).status).toBe(422)
  })

  it('rejects onboarding IDs that are not numeric and non-https callback URLs', async () => {
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: auth, body: JSON.stringify(body) })

    expect((await post('/v1/onboarding/subscribe', { wabaId: 'me' })).status).toBe(422)
    expect(
      (await post('/v1/onboarding/override-callback', {
        phoneNumberId: '123',
        callbackUrl: 'http://attacker.example/hook',
        verifyToken: 'x',
      })).status
    ).toBe(422)
  })
})

describe('Graph passthrough proxy allowlist', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'
  const auth = { 'X-API-Key': KEY, 'Content-Type': 'application/json' }

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('forwards the documented routes to graph.facebook.com/v24.0', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 }))

    const res = await app.request('/v24.0/123456/messages', { method: 'POST', headers: auth, body: '{}' })
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://graph.facebook.com/v24.0/123456/messages')
  })

  it.each([
    ['DELETE', '/v24.0/123456'],
    ['GET', '/v24.0/123456/phone_numbers'],
    ['POST', '/v24.0/123456/subscribed_apps'],
    ['POST', '/v24.0/123456/register'],
    ['GET', '/v24.0/me'],
    ['POST', '/v24.0/123456'],
  ])('refuses %s %s without calling Meta', async (method, path) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await app.request(path, { method, headers: auth, body: method === 'GET' ? undefined : '{}' })
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a generic 502 without leaking the network error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connect ECONNREFUSED 10.0.0.5:443 internal-host'))

    const res = await app.request('/v24.0/123456', { headers: auth })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('10.0.0.5')
  })
})

describe('Secrets and internals stay out of logs and responses', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('redacts hub.verify_token from the request log line', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'super-secret-verify-token'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await app.request('/webhook?hub.mode=subscribe&hub.verify_token=super-secret-verify-token&hub.challenge=42')

    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('/webhook')
    expect(logged).not.toContain('super-secret-verify-token')
    expect(logged).toContain('hub.verify_token=[REDACTED]')
  })

  it('returns a generic 500 for unexpected errors instead of the exception message', async () => {
    process.env.META_APP_SECRET = APP_SECRET
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A signed payload with a null entry makes the normalizer throw a TypeError
    const body = JSON.stringify({ entry: [null] })
    const res = await postWebhook(body, await signSubscriberPayload(body, APP_SECRET))

    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).toContain('Internal Server Error')
    expect(text).not.toContain('Cannot read properties')
  })
})

describe('redactSecrets', () => {
  it('redacts every secret-bearing query parameter and keeps the rest', () => {
    expect(redactSecrets('GET /x?code=abc&client_secret=s3cr3t&state=ok&access_token=EAAG')).toBe(
      'GET /x?code=[REDACTED]&client_secret=[REDACTED]&state=ok&access_token=[REDACTED]'
    )
  })
})

describe('Request body size limits', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_APP_SECRET: APP_SECRET, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('rejects webhook bodies above the limit with 413 before verifying them', async () => {
    const huge = 'x'.repeat(BODY_LIMITS.webhook + 1)
    const res = await postWebhook(huge, 'sha256=' + '0'.repeat(64))
    expect(res.status).toBe(413)
  })

  it('rejects /v1 JSON bodies above 1 MB with 413', async () => {
    const huge = JSON.stringify({ to: '1', kind: 'text', text: { body: 'x'.repeat(BODY_LIMITS.json) } })
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: huge,
    })
    expect(res.status).toBe(413)
  })

  it('allows media uploads above the JSON limit on /v24.0/:id/media', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: '1' }), { status: 200 }))
    const res = await app.request('/v24.0/123/media', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(BODY_LIMITS.json + 1024),
    })
    expect(res.status).toBe(200)
  })
})

describe('API key hardening (review follow-ups)', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'

  beforeEach(() => {
    process.env = { ...originalEnv, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('accepts X-API-Key even when Authorization carries a Meta bearer token (drop-in clients)', async () => {
    process.env.WATAHUB_API_KEY = KEY
    delete process.env.META_DEFAULT_WABA_ID
    const res = await app.request('/v1/templates', {
      headers: { Authorization: 'Bearer EAAG-some-meta-token', 'X-API-Key': KEY },
    })
    // Past auth → missing wabaId
    expect(res.status).toBe(400)
  })

  it.each(['too-short-key', 'wata_sk_live_secret_key_here'])(
    'refuses to serve with a weak WATAHUB_API_KEY (%s), even when the caller presents it',
    async (weakKey) => {
      process.env.WATAHUB_API_KEY = weakKey
      const res = await app.request('/v1/templates/123', { headers: { 'X-API-Key': weakKey } })
      expect(res.status).toBe(503)
    }
  )
})

describe('Review follow-ups: proxy query string and transport errors', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'
  const auth = { 'X-API-Key': KEY, 'Content-Type': 'application/json' }

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('strips verb tunneling, field expansion and token overrides from proxied query strings', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    await app.request(
      '/v24.0/123456?method=delete&fields=owner_business%7Bsystem_users%7D&access_token=x&phone_number_id=987',
      { headers: auth }
    )

    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://graph.facebook.com/v24.0/123456?phone_number_id=987')
  })

  it('maps a Graph timeout on /v1/messages to a generic 504', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeout)

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ to: '573001234567', phoneNumberId: '123', kind: 'text', text: { body: 'hi' } }),
    })

    expect(res.status).toBe(504)
    expect(await res.text()).not.toContain('aborted')
  })

  it('maps network failures on onboarding routes to a generic 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('getaddrinfo ENOTFOUND internal.corp'))

    const res = await app.request('/v1/onboarding/subscribe', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ wabaId: '123' }),
    })

    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('internal.corp')
  })
})
