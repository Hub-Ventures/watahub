import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app from '../src/index.js'
import { resetRateLimits } from '../src/middleware/rate-limit.js'

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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"access_token":"EAAG-new"}', { status: 200 }))

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
    ['appId without appSecret', { appId: '222' }],
    ['appSecret without appId', { appSecret: 'other-secret' }],
  ])('rejects %s instead of mixing it with the gateway credentials', async (_label, extra) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await exchange({ code: 'signup-code-123', ...extra })
    expect(res.status).toBe(422)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses a caller-supplied app when both appId and appSecret are given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"access_token":"EAAG-new"}', { status: 200 }))
    await exchange({ code: 'c', appId: '222', appSecret: 'other-secret' })
    const form = new URLSearchParams(String(fetchSpy.mock.calls[0][1]?.body))
    expect(form.get('client_id')).toBe('222')
    expect(form.get('client_secret')).toBe('other-secret')
  })

  it('never echoes the app secret when Meta rejects the code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"This authorization code has been used.","type":"OAuthException","code":100}}', { status: 400 })
    )
    const res = await exchange({ code: 'used-code' })
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(APP_SECRET)
    expect(text).not.toContain('used-code')
  })
})
