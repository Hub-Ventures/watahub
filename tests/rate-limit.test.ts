import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app from '../src/index.js'
import { AUTH_FAILURE_LIMIT, FixedWindowLimiter, resetRateLimits } from '../src/middleware/rate-limit.js'

const KEY = 'k'.repeat(48)

function callApi(apiKey: string, ip = '203.0.113.7') {
  return app.request('/v1/templates/123', { headers: { 'X-API-Key': apiKey, 'CF-Connecting-IP': ip } })
}

describe('FixedWindowLimiter', () => {
  it('blocks after the limit and reopens when the window ends', () => {
    const limiter = new FixedWindowLimiter(2, 1_000)
    limiter.hit('a', 0)
    expect(limiter.blockedFor('a', 10)).toBe(0)
    limiter.hit('a', 10)
    expect(limiter.blockedFor('a', 10)).toBe(1)
    expect(limiter.blockedFor('b', 10)).toBe(0)
    expect(limiter.blockedFor('a', 1_001)).toBe(0)
  })

  it('stays bounded when full', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, 2)
    for (const key of ['a', 'b', 'c']) limiter.hit(key, 0)
    // 'a' was evicted to make room for 'c'
    expect(limiter.blockedFor('a', 1)).toBe(0)
    expect(limiter.blockedFor('c', 1)).toBe(60)
  })
})

describe('Authentication brute-force brake', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token', META_WEBHOOK_VERIFY_TOKEN: 'verify-token-0123456789' }
    resetRateLimits()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('answers 429 with Retry-After once a client exceeds the failed API key limit', async () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
      expect((await callApi('wrong-key')).status).toBe(401)
    }
    const blocked = await callApi('wrong-key')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)

    // Even the right key waits out the window, so guessing cannot continue
    expect((await callApi(KEY)).status).toBe(429)
  })

  it('keeps other clients unaffected', async () => {
    for (let i = 0; i <= AUTH_FAILURE_LIMIT; i++) await callApi('wrong-key', '203.0.113.7')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":[]}', { status: 200 }))
    expect((await callApi(KEY, '198.51.100.9')).status).toBe(200)
  })

  it('does not count successful requests as failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":[]}', { status: 200 }))
    for (let i = 0; i < AUTH_FAILURE_LIMIT + 5; i++) {
      expect((await callApi(KEY)).status).toBe(200)
    }
  })

  it('limits verify token guessing on GET /webhook', async () => {
    const verify = (token: string) =>
      app.request(`/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`, { headers: { 'CF-Connecting-IP': '203.0.113.8' } })

    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) expect((await verify('guess')).status).toBe(403)
    expect((await verify('guess')).status).toBe(429)
    expect((await verify('verify-token-0123456789')).status).toBe(429)
  })
})

describe('RATE_LIMIT_PER_MINUTE', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
    resetRateLimits()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":[]}', { status: 200 }))
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('is off by default', async () => {
    for (let i = 0; i < 30; i++) expect((await callApi(KEY)).status).toBe(200)
  })

  it('limits requests per client when set', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '3'
    for (let i = 0; i < 3; i++) expect((await callApi(KEY)).status).toBe(200)
    expect((await callApi(KEY)).status).toBe(429)
    expect((await callApi(KEY, '198.51.100.9')).status).toBe(200)
  })

  it('keys on TRUSTED_CLIENT_IP_HEADER when the operator sets one', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '1'
    process.env.TRUSTED_CLIENT_IP_HEADER = 'X-Real-IP'
    const call = (realIp: string) => app.request('/v1/templates/123', { headers: { 'X-API-Key': KEY, 'X-Real-IP': realIp } })
    expect((await call('192.0.2.1')).status).toBe(200)
    expect((await call('192.0.2.1')).status).toBe(429)
    expect((await call('192.0.2.2')).status).toBe(200)
  })
})
