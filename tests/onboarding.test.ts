import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app from '../src/index.js'
import { resetRateLimits } from '../src/http/rate-limit.js'

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
