import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app from '../src/index.js'
import { parseAllowedOrigins } from '../src/middleware/cors.js'
import { validateEnv } from '../src/utils/env.js'

const KEY = 'k'.repeat(48)

describe('Security headers', () => {
  it('sets hardening headers on every response', async () => {
    const res = await app.request('/health')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  describe('authenticated surfaces', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token', META_APP_ID: '123', META_APP_SECRET: 'app-secret' }
    })

    afterEach(() => {
      process.env = originalEnv
      vi.restoreAllMocks()
    })

    it('marks token-bearing responses as no-store', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"access_token":"EAAG-new"}', { status: 200 }))
      const res = await app.request('/v1/onboarding/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
        body: JSON.stringify({ code: 'signup-code' }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('marks auth failures as no-store too', async () => {
      const res = await app.request('/v1/templates/123', { headers: { 'X-API-Key': 'wrong' } })
      expect(res.status).toBe(401)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('strips Graph CORS and cookie headers from proxied responses and adds no-store', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"url":"https://lookaside.fbsbx.com/x"}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'set-cookie': 'fr=abc; Domain=.facebook.com',
            'x-fb-trace-id': 'trace',
          },
        })
      )
      const res = await app.request('/v24.0/123456', { headers: { 'X-API-Key': KEY } })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-type')).toBe('application/json')
    })
  })
})

describe('CORS', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('sends no CORS headers by default', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers preflights only for listed origins when CORS_ALLOWED_ORIGINS is set', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com, https://admin.example.com'

    const preflight = (origin: string) =>
      app.request('/v1/messages', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key' },
      })

    const allowed = await preflight('https://admin.example.com')
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://admin.example.com')

    const denied = await preflight('https://evil.example')
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('ignores wildcards and malformed origins', () => {
    expect(parseAllowedOrigins('*, https://ok.example.com, https://bad.example.com/path, nope')).toEqual(['https://ok.example.com'])
  })

  it('rejects wildcard origins at boot', () => {
    const base = { META_APP_SECRET: 's', META_WEBHOOK_VERIFY_TOKEN: 'verify-token-0123456789', WATAHUB_API_KEY: KEY }
    expect(validateEnv({ ...base, CORS_ALLOWED_ORIGINS: '*' }).ok).toBe(false)
    expect(validateEnv({ ...base, CORS_ALLOWED_ORIGINS: 'https://app.example.com,https://b.example.com' }).ok).toBe(true)
  })
})
