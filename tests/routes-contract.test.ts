import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from '../src/index.js'
import { signSubscriberPayload } from '../src/services/crypto.js'
import { jsonResponse, metaError, mockFetch, postJson } from './helpers/fetch-mock.js'

/**
 * Contract tests that pin the HTTP behavior of every route (status codes,
 * response bodies and the requests sent to Meta) on the hardened gateway.
 * Security-specific rules (auth, allowlists, limits) live in security.test.ts.
 */
describe('HTTP route contracts', () => {
  const originalEnv = process.env
  const KEY = 'wk_test_0123456789abcdef0123456789abcdef'
  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), 'x-api-key': KEY },
  })

  beforeEach(() => {
    process.env = { ...originalEnv, META_SYSTEM_USER_TOKEN: 'SYS_TOKEN', WATAHUB_API_KEY: KEY }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Fail loudly instead of reaching the real Graph API when a test forgets to mock.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network call'))
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  const json = async (res: Response) => (await res.json()) as Record<string, any>

  describe('app', () => {
    it('returns JSON 404 for unknown endpoints', async () => {
      const res = await app.request('/nope')
      expect(res.status).toBe(404)
      expect(await json(res)).toEqual({ error: 'Endpoint not found', path: '/nope' })
    })

    it('prefers Worker bindings over process.env', async () => {
      const bindingKey = 'wk_binding_0123456789abcdef0123456789abcdef'
      mockFetch(jsonResponse({ data: [] }))
      const res = await app.request(
        '/v1/templates/456',
        { headers: { 'x-api-key': bindingKey } },
        { WATAHUB_API_KEY: bindingKey }
      )
      expect(res.status).toBe(200)
    })

    it('serves /health without auth', async () => {
      const res = await app.request('/health')
      expect(res.status).toBe(200)
      expect(await json(res)).toMatchObject({ status: 'ok', service: 'watahub', version: '0.1.0' })
    })
  })

  describe('POST /v1/messages', () => {
    const valid = { to: '+573001234567', phoneNumberId: '123', kind: 'text', text: { body: 'Hola' } }

    it('rejects malformed JSON with 400', async () => {
      const res = await app.request('/v1/messages', authed(postJson('{nope')))
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Malformed JSON payload' })
    })

    it('returns field errors with 422', async () => {
      const res = await app.request('/v1/messages', authed(postJson({ to: '', kind: 'fax' })))
      expect(res.status).toBe(422)
      const body = await json(res)
      expect(body.error).toBe('Validation failed')
      expect(Object.keys(body.details).sort()).toEqual(['kind', 'to'])
    })

    it('requires a phone number id', async () => {
      const res = await app.request('/v1/messages', authed(postJson({ ...valid, phoneNumberId: undefined })))
      expect(res.status).toBe(400)
      expect((await json(res)).error).toMatch(/^Missing phoneNumberId/)
    })

    it('requires an access token (500)', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(500)
      expect(await json(res)).toEqual({
        error: 'Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header.',
      })
    })

    it('sends through Meta and returns the normalized result', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'wamid.OK' }] }))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({
        success: true,
        messageId: 'wamid.OK',
        recipient: '573001234567',
        phoneNumberId: '123',
      })
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/123/messages')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SYS_TOKEN')
    })

    it('resolves phone id from header, then env; token and version overrides', async () => {
      process.env.META_DEFAULT_PHONE_NUMBER_ID = '999'
      process.env.META_API_VERSION = 'v30.0'
      const spy = mockFetch(jsonResponse({ messages: [] }), jsonResponse({ messages: [] }))
      const body = { ...valid, phoneNumberId: undefined }
      await app.request(
        '/v1/messages',
        authed(postJson(body, { 'x-phone-number-id': '555', 'x-meta-access-token': 'OVR' }))
      )
      await app.request('/v1/messages', authed(postJson(body)))
      expect(spy.mock.calls[0][0]).toBe('https://graph.facebook.com/v30.0/555/messages')
      expect(((spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer OVR')
      expect(spy.mock.calls[1][0]).toBe('https://graph.facebook.com/v30.0/999/messages')
    })

    it('maps Meta errors to classified error bodies (with type)', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(metaError(130429, 'slow down', { error_subcode: 7 })), {
            status: 429,
            headers: { 'Retry-After': '0' },
          })
        )
      )
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(429)
      expect(await json(res)).toEqual({
        error: {
          message: 'Meta Graph API Error (130429): slow down',
          code: 130429,
          subcode: 7,
          type: 'OAuthException',
          category: 'rate_limit',
          retryable: true,
          action: 'Back off with exponential jitter before retrying request',
        },
      })
    })

    it('uses 502 when the Meta status is outside 4xx/5xx', async () => {
      mockFetch(jsonResponse(metaError(1), 302))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(502)
    })

    it('returns a generic 502 for transport failures without echoing the error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('socket hang up 10.0.0.7'))
      const res = await app.request('/v1/messages', authed(postJson(valid)))
      expect(res.status).toBe(502)
      expect(await json(res)).toEqual({ error: { message: 'Meta Graph API unreachable' } })
    })
  })

  describe('GET /v1/templates', () => {
    it('resolves wabaId from path, query, then env', async () => {
      process.env.META_DEFAULT_WABA_ID = '3'
      const spy = mockFetch(jsonResponse({ data: [1] }), jsonResponse({ data: [2] }), jsonResponse({ data: [3] }))
      expect(await json(await app.request('/v1/templates/1', authed()))).toEqual({ data: [1] })
      expect(await json(await app.request('/v1/templates?wabaId=2', authed()))).toEqual({ data: [2] })
      expect(await json(await app.request('/v1/templates', authed()))).toEqual({ data: [3] })
      expect(spy.mock.calls.map((call) => call[0])).toEqual([
        'https://graph.facebook.com/v24.0/1/message_templates',
        'https://graph.facebook.com/v24.0/2/message_templates',
        'https://graph.facebook.com/v24.0/3/message_templates',
      ])
    })

    it('requires wabaId and token', async () => {
      const missingWaba = await app.request('/v1/templates', authed())
      expect(missingWaba.status).toBe(400)
      expect((await json(missingWaba)).error).toMatch(/^Missing wabaId/)
      delete process.env.META_SYSTEM_USER_TOKEN
      expect((await app.request('/v1/templates/1', authed())).status).toBe(500)
    })

    it('maps Meta errors without the type field', async () => {
      mockFetch(jsonResponse(metaError(190, 'expired'), 401))
      const res = await app.request('/v1/templates/1', authed())
      expect(res.status).toBe(401)
      const body = await json(res)
      expect(body.error).not.toHaveProperty('type')
      expect(body.error).toMatchObject({ code: 190, category: 'auth', retryable: false })
    })
  })

  describe('POST /v1/onboarding/exchange', () => {
    it('validates the body', async () => {
      expect((await app.request('/v1/onboarding/exchange', authed(postJson('x')))).status).toBe(400)
      expect((await app.request('/v1/onboarding/exchange', authed(postJson({})))).status).toBe(422)
    })

    it('requires app credentials from body or env', async () => {
      delete process.env.META_APP_ID
      delete process.env.META_APP_SECRET
      const res = await app.request('/v1/onboarding/exchange', authed(postJson({ code: 'C' })))
      expect(res.status).toBe(400)
      expect(await json(res)).toEqual({ error: 'Missing META_APP_ID or META_APP_SECRET configuration' })
    })

    it('exchanges the code without needing a system token', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      process.env.META_APP_ID = '111'
      process.env.META_APP_SECRET = 'ENV_SECRET'
      const spy = mockFetch(jsonResponse({ access_token: 'T' }))
      const res = await app.request('/v1/onboarding/exchange', authed(postJson({ code: 'C', appId: '222' })))
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ accessToken: 'T' })
      expect(String(spy.mock.calls[0][0])).toContain('client_id=222&client_secret=ENV_SECRET&code=C')
    })

    it('maps Meta errors without the type field', async () => {
      process.env.META_APP_ID = '111'
      process.env.META_APP_SECRET = 'S'
      mockFetch(jsonResponse(metaError(100), 400))
      const res = await app.request('/v1/onboarding/exchange', authed(postJson({ code: 'C' })))
      expect(res.status).toBe(400)
      expect((await json(res)).error).not.toHaveProperty('type')
    })
  })

  describe('POST /v1/onboarding/subscribe and override-callback', () => {
    it('subscribe returns success flag from Meta', async () => {
      mockFetch(jsonResponse({}), jsonResponse(metaError(100), 400))
      const ok = await app.request('/v1/onboarding/subscribe', authed(postJson({ wabaId: '456' })))
      expect(await json(ok)).toEqual({ success: true, wabaId: '456' })
      const ko = await app.request('/v1/onboarding/subscribe', authed(postJson({ wabaId: '456' })))
      expect(ko.status).toBe(200)
      expect(await json(ko)).toEqual({ success: false, wabaId: '456' })
    })

    it('subscribe validates and needs a token', async () => {
      expect((await app.request('/v1/onboarding/subscribe', authed(postJson({})))).status).toBe(422)
      delete process.env.META_SYSTEM_USER_TOKEN
      const res = await app.request('/v1/onboarding/subscribe', authed(postJson({ wabaId: '456' })))
      expect(res.status).toBe(500)
      expect(await json(res)).toEqual({ error: 'Missing Meta access token' })
    })

    it('override-callback validates URL and returns success flag', async () => {
      const bad = await app.request(
        '/v1/onboarding/override-callback',
        authed(postJson({ phoneNumberId: '123', callbackUrl: 'not-a-url', verifyToken: 'V' }))
      )
      expect(bad.status).toBe(422)
      mockFetch(jsonResponse({}))
      const ok = await app.request(
        '/v1/onboarding/override-callback',
        authed(postJson({ phoneNumberId: '123', callbackUrl: 'https://cb.example', verifyToken: 'V' }))
      )
      expect(await json(ok)).toEqual({ success: true, phoneNumberId: '123' })
    })
  })

  describe('/v24.0/* proxy', () => {
    it('forwards method, body, content type and token', async () => {
      const spy = mockFetch(jsonResponse({ messages: [{ id: 'm' }] }, 201))
      const res = await app.request('/v24.0/123/messages', authed(postJson({ a: 1 }, { 'x-meta-access-token': 'OVR' })))
      expect(res.status).toBe(201)
      expect(await json(res)).toEqual({ messages: [{ id: 'm' }] })
      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v24.0/123/messages')
      expect(init.method).toBe('POST')
      const headers = init.headers as Headers
      expect(headers.get('authorization')).toBe('Bearer OVR')
      expect(headers.get('content-type')).toBe('application/json')
      expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"a":1}')
    })

    it('sends no body on GET and strips encoding headers', async () => {
      const spy = mockFetch(
        new Response('{}', { status: 200, headers: { 'content-length': '2', 'x-fb-trace-id': 'T' } })
      )
      const res = await app.request('/v24.0/789', authed())
      expect((spy.mock.calls[0][1] as RequestInit).body).toBeUndefined()
      expect(res.headers.get('content-length')).toBeNull()
      expect(res.headers.get('x-fb-trace-id')).toBe('T')
    })

    it('needs a token', async () => {
      delete process.env.META_SYSTEM_USER_TOKEN
      expect((await app.request('/v24.0/789', authed())).status).toBe(500)
    })
  })

  describe('POST /webhook', () => {
    const APP_SECRET = 'APP_SECRET'
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: 'D', phone_number_id: 'P' },
                messages: [{ id: 'wamid.in', from: '1', timestamp: '1', type: 'text', text: { body: 'x' } }],
              },
            },
          ],
        },
      ],
    }
    const raw = JSON.stringify(payload)
    const signed = async (body = raw): Promise<RequestInit> => ({
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': await signSubscriberPayload(body, APP_SECRET) },
    })

    beforeEach(() => {
      process.env.META_APP_SECRET = APP_SECRET
    })

    it('acknowledges with the number of normalized events', async () => {
      const res = await app.request('/webhook', await signed())
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ status: 'received', eventsCount: 1 })
    })

    it('rejects bad signatures with 401 and signed bad JSON with 400', async () => {
      const unsigned = await app.request('/webhook', { method: 'POST', body: raw })
      expect(unsigned.status).toBe(401)
      expect(await json(unsigned)).toEqual({ error: 'Invalid HMAC signature' })
      expect((await app.request('/webhook', await signed('{'))).status).toBe(400)
    })

    it('forwards signed events to the subscriber via waitUntil', async () => {
      process.env.SUBSCRIBER_WEBHOOK_URL = 'https://subscriber.example/hook'
      process.env.SUBSCRIBER_WEBHOOK_SECRET = 'SUB_SECRET'
      const spy = mockFetch(jsonResponse({}))
      const pending: Array<Promise<unknown>> = []
      const executionCtx = {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException: () => {},
        props: {},
      }
      const res = await app.request('/webhook', await signed(), {}, executionCtx)
      expect(res.status).toBe(200)
      await Promise.all(pending)

      const [url, init] = spy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://subscriber.example/hook')
      const headers = init.headers as Record<string, string>
      expect(headers['User-Agent']).toBe('Watahub-Gateway/0.1.0')
      expect(headers['x-watahub-signature']).toBe(await signSubscriberPayload(String(init.body), 'SUB_SECRET'))
      const forwarded = JSON.parse(String(init.body))
      expect(forwarded.raw).toEqual(payload)
      expect(forwarded.events).toHaveLength(1)
    })
  })
})
