import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import app from '../src/index.js'
import { resetRateLimits } from '../src/http/rate-limit.js'

const KEY = 'k'.repeat(48)

describe('Meta error responses', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'EAAG-system-token' }
    resetRateLimits()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('returns the classified error but not Meta trace ids, error_data or the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: '(#131047) Re-engagement message',
            type: 'OAuthException',
            code: 131047,
            error_data: {
              messaging_product: 'whatsapp',
              details: 'internal routing for +573001234567 via node 10.2.3.4',
            },
            fbtrace_id: 'AbCdEfTrace',
          },
        }),
        { status: 400 }
      )
    )

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify({ to: '+573001234567', phoneNumberId: '1234567890', kind: 'text', text: { body: 'hi' } }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: Record<string, unknown> }
    expect(body.error).toMatchObject({ code: 131047, category: 'unknown', retryable: false })
    const allowed = ['action', 'category', 'code', 'message', 'retryable', 'subcode', 'type']
    expect(Object.keys(body.error).every((key) => allowed.includes(key))).toBe(true)
    const text = JSON.stringify(body)
    expect(text).not.toContain('AbCdEfTrace')
    expect(text).not.toContain('10.2.3.4')
    expect(text).not.toContain('EAAG-system-token')
  })
})
