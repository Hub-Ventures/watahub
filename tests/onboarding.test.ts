import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app, { createApp, MemoryLineStore, type LineStore } from '../src/index.js'
import { resetRateLimits } from '../src/http/rate-limit.js'
import type { Logger } from '../src/logger.js'

const KEY = 'k'.repeat(48)
const APP_SECRET = 'gateway-app-secret'

function exchange(body: Record<string, unknown>) {
  return app.request('/v1/onboarding/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify(body),
  })
}

describe('POST /v1/onboarding/exchange (Embedded Signup)', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_APP_ID: '111', META_APP_SECRET: APP_SECRET }
    resetRateLimits()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('sends the app secret and signup code in a POST body, never in the URL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"access_token":"EAAG-new"}', { status: 200 }))

    const res = await exchange({ code: 'signup-code-123' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accessToken: 'EAAG-new' })

    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://graph.facebook.com/v24.0/oauth/access_token')
    expect(String(url)).not.toContain(APP_SECRET)
    expect(init?.method).toBe('POST')
    const form = new URLSearchParams(String(init?.body))
    expect(form.get('client_id')).toBe('111')
    expect(form.get('client_secret')).toBe(APP_SECRET)
    expect(form.get('code')).toBe('signup-code-123')
  })

  it('does not retry a failed exchange (signup codes are single-use)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"error":{"message":"Service unavailable","code":2}}', { status: 503 }))

    const res = await exchange({ code: 'signup-code-123' })
    expect(res.status).toBe(503)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['appId', { appId: '222' }],
    ['appSecret', { appSecret: 'other-secret' }],
    ['both', { appId: '222', appSecret: 'other-secret' }],
  ])('rejects caller-supplied app credentials (%s) without calling Meta', async (_label, extra) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await exchange({ code: 'signup-code-123', ...extra })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { details: Record<string, string[]> }
    for (const key of Object.keys(extra)) expect(body.details[key]).toBeDefined()
    expect(JSON.stringify(body)).not.toContain('other-secret')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never echoes the app secret when Meta rejects the code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        '{"error":{"message":"This authorization code has been used.","type":"OAuthException","code":100}}',
        { status: 400 }
      )
    )
    const res = await exchange({ code: 'used-code' })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(APP_SECRET)
    expect(text).not.toContain('used-code')
  })
})

describe('POST /v1/onboarding/subscribe and override-callback surface Meta errors', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-expired' }
    resetRateLimits()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  const expired = () =>
    new Response('{"error":{"message":"Error validating access token","type":"OAuthException","code":190}}', {
      status: 401,
    })

  it.each([
    ['/v1/onboarding/subscribe', { wabaId: '123456' }],
    [
      '/v1/onboarding/override-callback',
      { phoneNumberId: '123456', callbackUrl: 'https://hooks.example.com/w', verifyToken: 'verify-token-123' },
    ],
  ])('%s returns the classified auth error instead of 200 success:false', async (path, body) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(expired()))
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 190, category: 'auth', retryable: false } })
  })

  it('subscribe still answers success on 2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"success":true}', { status: 200 }))
    const res = await app.request('/v1/onboarding/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify({ wabaId: '123456' }),
    })
    expect(await res.json()).toEqual({ success: true, wabaId: '123456' })
  })
})

describe('line connect token custody', () => {
  const originalEnv = process.env
  const phoneNumberId = '770000000000001'
  const wabaId = '770000000000002'
  const biz = 'BIZ_LINE_TOKEN'
  const code = 'line-code'
  const pin = '581063'
  const auth = { 'Content-Type': 'application/json', 'X-API-Key': KEY }

  function memoryLogger() {
    const lines = { info: [] as string[], error: [] as string[] }
    const logger: Logger = {
      info: (message) => lines.info.push(message),
      error: (message) => lines.error.push(message),
    }
    return { logger, lines }
  }

  function graphOk(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      WATAHUB_API_KEY: KEY,
      META_APP_ID: '111',
      META_APP_SECRET: APP_SECRET,
      META_CONFIGURATION_ID: '333',
    }
    delete process.env.META_SYSTEM_USER_TOKEN
    resetRateLimits()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  const connectBody = { code, wabaId, phoneNumberId, pin }

  it('sends with the stored token, and the header overrides it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: biz }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: 'wamid.1' }] }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: 'wamid.2' }] }))
    const gateway = createApp()
    const connect = await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(connectBody),
    })
    expect(connect.status).toBe(200)
    expect(JSON.stringify(await connect.json())).not.toContain(biz)

    const send = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ to: '15551234567', phoneNumberId, kind: 'text', text: { body: 'hi' } }),
    })
    expect(send.status).toBe(200)
    expect(new Headers((fetchSpy.mock.calls[3][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${biz}`)

    process.env.META_SYSTEM_USER_TOKEN = 'SYS_LOSES'
    const overridden = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: { ...auth, 'X-Meta-Access-Token': 'HEADER_WINS' },
      body: JSON.stringify({ to: '15551234567', phoneNumberId, kind: 'text', text: { body: 'hi' } }),
    })
    expect(overridden.status).toBe(200)
    expect(new Headers((fetchSpy.mock.calls[4][1] as RequestInit).headers).get('authorization')).toBe(
      'Bearer HEADER_WINS'
    )
  })

  it('prefers the stored token over META_SYSTEM_USER_TOKEN', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'SYS_LOSES'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: biz }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: 'wamid.3' }] }))
    const gateway = createApp()
    await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(connectBody),
    })
    await gateway.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ to: '15551234567', phoneNumberId, kind: 'text', text: { body: 'hi' } }),
    })
    expect(new Headers((fetchSpy.mock.calls[3][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${biz}`)
  })

  it('keeps the token when register fails and does not echo it', async () => {
    const { logger, lines } = memoryLogger()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: biz }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ error: { message: 'pin mismatch', type: 'OAuthException', code: 133005 } }, 400))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: 'wamid.4' }] }))
    const gateway = createApp({ logger })
    const res = await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(connectBody),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ step: 'register', error: { code: 133005 } })
    expect(JSON.stringify(body)).not.toContain(biz)
    expect(JSON.stringify(body)).not.toContain(code)
    expect(JSON.stringify(body)).not.toContain(pin)
    expect(lines.error.join('\n')).not.toContain(biz)
    expect(lines.error.join('\n')).not.toContain(code)
    expect(lines.info.join('\n')).not.toContain(code)

    const send = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ to: '15551234567', phoneNumberId, kind: 'text', text: { body: 'hi' } }),
    })
    expect(send.status).toBe(200)
    expect(new Headers((fetchSpy.mock.calls[3][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${biz}`)
  })

  it('does not store a line when the exchange fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      graphOk({ error: { message: 'bad code', code: 100, type: 'OAuthException' } }, 400)
    )
    const gateway = createApp()
    const res = await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(connectBody),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ step: 'exchange', error: { code: 100 } })
    const send = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ to: '15551234567', phoneNumberId, kind: 'text', text: { body: 'hi' } }),
    })
    expect(send.status).toBe(500)
  })

  it('answers 502 without the token when the line store throws after exchange', async () => {
    const { logger, lines } = memoryLogger()
    const lineStore: LineStore = {
      get: () => undefined,
      put: () => {
        throw new Error(`kv down ${biz}`)
      },
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(graphOk({ access_token: biz }))
    const gateway = createApp({ logger, lineStore })
    const res = await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(connectBody),
    })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain(biz)
    expect(text).not.toContain(code)
    expect(text).not.toContain('kv down')
    expect(lines.error.join('\n')).not.toContain(biz)
    expect(lines.error.join('\n')).toContain('Error')
  })

  it('rejects caller app credentials without calling Meta', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const gateway = createApp()
    const res = await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ ...connectBody, appSecret: 'other-secret' }),
    })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).not.toContain('other-secret')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses the stored token for media upload and proxied sends, not for a media id lookup', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: biz }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ id: 'MEDIA' }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: 'wamid.p' }] }))
      .mockResolvedValueOnce(graphOk({ url: 'https://cdn.example/a.jpg' }))
    process.env.META_SYSTEM_USER_TOKEN = 'SYS_FOR_MEDIA_GET'
    const gateway = createApp()
    await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(connectBody),
    })
    const upload = await gateway.request(`/v1/media/${phoneNumberId}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=xyz' },
      body: 'bytes',
    })
    expect(upload.status).toBe(200)
    expect(new Headers((fetchSpy.mock.calls[3][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${biz}`)

    await gateway.request(`/v24.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    })
    expect(new Headers((fetchSpy.mock.calls[4][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${biz}`)

    const media = await gateway.request(`/v24.0/${phoneNumberId}`, { headers: { 'X-API-Key': KEY } })
    expect(media.status).toBe(200)
    expect(new Headers((fetchSpy.mock.calls[5][1] as RequestInit).headers).get('authorization')).toBe(
      'Bearer SYS_FOR_MEDIA_GET'
    )
  })

  it('does not use a line token for templates or subscribe, which have no phone id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: biz }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ success: true }))
    const gateway = createApp()
    await gateway.request('/v1/onboarding/connect', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(connectBody),
    })
    expect((await gateway.request(`/v1/templates/${wabaId}`, { headers: { 'X-API-Key': KEY } })).status).toBe(500)
    const subscribe = await gateway.request('/v1/onboarding/subscribe', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ wabaId }),
    })
    expect(subscribe.status).toBe(500)
  })

  it('falls through an empty stored token to the system token', async () => {
    const store = new MemoryLineStore()
    store.put({ phoneNumberId, wabaId, accessToken: '' })
    process.env.META_SYSTEM_USER_TOKEN = 'SYS_FALLBACK'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(graphOk({ messages: [{ id: 'wamid.e' }] }))
    const gateway = createApp({ lineStore: store })
    const res = await gateway.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ to: '15551234567', phoneNumberId, kind: 'text', text: { body: 'hi' } }),
    })
    expect(res.status).toBe(200)
    expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe(
      'Bearer SYS_FALLBACK'
    )
  })

  it('launch refuses a non-numeric configuration id and does not echo it', async () => {
    process.env.META_CONFIGURATION_ID = 'not-a-number'
    const { logger, lines } = memoryLogger()
    const gateway = createApp({ logger })
    const res = await gateway.request('/v1/onboarding/launch', { headers: { 'X-API-Key': KEY } })
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toContain('not-a-number')
    expect(text).not.toContain(APP_SECRET)
    expect(lines.error.join('\n')).not.toContain('not-a-number')
    expect(lines.error.join('\n')).not.toContain(APP_SECRET)
  })
})
