import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from '../src/index.js'

describe('HTTP Route Endpoints', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('GET /health returns 200 with service information', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.service).toBe('watahub')
    expect(body.version).toBe('0.1.0')
  })

  it('GET /webhook succeeds with correct verify token handshake', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'secret-verify-token-xyz'

    const res = await app.request(
      '/webhook?hub.mode=subscribe&hub.verify_token=secret-verify-token-xyz&hub.challenge=test_challenge_12345'
    )

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe('test_challenge_12345')
  })

  it('GET /webhook rejects handshake with invalid token', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'secret-verify-token-xyz'

    const res = await app.request(
      '/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test_challenge_12345'
    )

    expect(res.status).toBe(403)
  })

  it('POST /v1/messages rejects invalid schema (missing required fields)', async () => {
    process.env.WATAHUB_API_KEY = 'wh_secret_key_0123456789abcdef0123456789'

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'wh_secret_key_0123456789abcdef0123456789',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('Validation failed')
  })

  it('POST /v1/messages enforces WATAHUB_API_KEY if configured', async () => {
    process.env.WATAHUB_API_KEY = 'wh_secret_key_0123456789abcdef0123456789'

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: '573001234567',
        kind: 'text',
        text: { body: 'Hello' },
      }),
    })

    expect(res.status).toBe(401)
  })

  it('POST /v24.0/PHONE_123/messages enforces API Key when configured', async () => {
    process.env.WATAHUB_API_KEY = 'wh_secret_key_0123456789abcdef0123456789'

    const res = await app.request('/v24.0/PHONE_123/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp' }),
    })

    expect(res.status).toBe(401)
  })
})
