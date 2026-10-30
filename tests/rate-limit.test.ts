import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app from '../src/index.js'
import { AUTH_FAILURE_LIMIT, FixedWindowLimiter, limiterKey, resetRateLimits } from '../src/http/rate-limit.js'

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

describe('limiterKey', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(limiterKey('203.0.113.7')).toBe('203.0.113.7')
    expect(limiterKey('unknown')).toBe('unknown')
  })

  it('keys IPv6 by its /64, whatever the notation', () => {
    const key = limiterKey('2001:db8:abcd:12::1')
    expect(key).toBe('2001:db8:abcd:12::/64')
    expect(limiterKey('2001:db8:abcd:12:ffff:1:2:3')).toBe(key)
    expect(limiterKey('2001:0DB8:ABCD:0012:0000:0000:0000:0001')).toBe(key)
    expect(limiterKey('2001:db8:abcd:12::1%eth0')).toBe(key)
    expect(limiterKey('2001:db8:abcd:13::1')).not.toBe(key)
    expect(limiterKey('::1')).toBe('0:0:0:0::/64')
  })

  it('keys IPv4-mapped IPv6 as the IPv4 address', () => {
    expect(limiterKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(limiterKey('::FFFF:cb00:7107')).toBe('203.0.113.7')
  })

  it('leaves values that are not valid IPv6 untouched', () => {
    for (const value of ['1::2::3', '2001:db8::zz', '1:2:3:4:5:6:7', '::ffff:300.1.1.1']) {
      expect(limiterKey(value)).toBe(value)
    }
  })
})

describe('Authentication brute-force brake', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      WATAHUB_API_KEY: KEY,
      META_SYSTEM_USER_TOKEN: 'EAAG-system-token',
      META_WEBHOOK_VERIFY_TOKEN: 'verify-token-0123456789',
    }
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
  })

  it('never locks out the correct key, even from an address that is failing', async () => {
    // Clients behind one proxy or NAT share an address with whoever is guessing
    for (let i = 0; i <= AUTH_FAILURE_LIMIT; i++) await callApi('wrong-key')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":[]}', { status: 200 }))
    expect((await callApi(KEY)).status).toBe(200)
  })

  it('keeps verify-token and API-key failures on separate counters', async () => {
    for (let i = 0; i <= AUTH_FAILURE_LIMIT; i++) {
      await app.request('/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1', {
        headers: { 'CF-Connecting-IP': '203.0.113.7' },
      })
    }
    expect((await callApi('wrong-key')).status).toBe(401)
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

  it('counts failed keys per IPv6 /64, so rotating inside the /64 buys no fresh attempts', async () => {
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) {
      expect((await callApi('wrong-key', `2001:db8:abcd:12::${i + 1}`)).status).toBe(401)
    }
    expect((await callApi('wrong-key', '2001:db8:abcd:12:ffff::9')).status).toBe(429)
    expect((await callApi('wrong-key', '2001:db8:abcd:13::1')).status).toBe(401)
  })

  it('limits verify token guessing on GET /webhook', async () => {
    const verify = (token: string) =>
      app.request(`/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`, {
        headers: { 'CF-Connecting-IP': '203.0.113.8' },
      })

    for (let i = 0; i < AUTH_FAILURE_LIMIT; i++) expect((await verify('guess')).status).toBe(403)
    expect((await verify('guess')).status).toBe(429)
    // Meta's own handshake still succeeds from a throttled address
    expect((await verify('verify-token-0123456789')).status).toBe(200)
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

  it('does not let requests without a valid key spend the quota', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '3'
    for (let i = 0; i < 100; i++) {
      const res = await app.request('/v1/templates/123', { headers: { 'CF-Connecting-IP': '203.0.113.7' } })
      // 401 until the failed-key brake kicks in, then 429 from that brake
      expect([401, 429]).toContain(res.status)
    }
    expect((await callApi(KEY)).status).toBe(200)
  })

  it('shares the quota across one IPv6 /64 and not across different /64s', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '1'
    expect((await callApi(KEY, '2001:db8:abcd:12::1')).status).toBe(200)
    expect((await callApi(KEY, '2001:db8:abcd:12:ffff::9')).status).toBe(429)
    expect((await callApi(KEY, '2001:db8:abcd:13::1')).status).toBe(200)
  })

  it('counts IPv4 and its IPv4-mapped IPv6 form as the same client', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '1'
    expect((await callApi(KEY, '198.51.100.20')).status).toBe(200)
    expect((await callApi(KEY, '::ffff:198.51.100.20')).status).toBe(429)
  })

  it('keys on TRUSTED_CLIENT_IP_HEADER when the operator sets one', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '1'
    process.env.TRUSTED_CLIENT_IP_HEADER = 'X-Real-IP'
    const call = (realIp: string) =>
      app.request('/v1/templates/123', { headers: { 'X-API-Key': KEY, 'X-Real-IP': realIp } })
    expect((await call('192.0.2.1')).status).toBe(200)
    expect((await call('192.0.2.1')).status).toBe(429)
    expect((await call('192.0.2.2')).status).toBe(200)
  })

  it('uses the last X-Forwarded-For entry, the one the trusted proxy wrote', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '1'
    process.env.TRUSTED_CLIENT_IP_HEADER = 'X-Forwarded-For'
    const call = (spoofed: string) =>
      app.request('/v1/templates/123', { headers: { 'X-API-Key': KEY, 'X-Forwarded-For': `${spoofed}, 192.0.2.50` } })
    expect((await call('1.2.3.4')).status).toBe(200)
    // A different client-supplied prefix does not buy a fresh window
    expect((await call('5.6.7.8')).status).toBe(429)
  })
})
