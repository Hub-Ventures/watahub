import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from '../src/index.js'
import type { Logger } from '../src/logger.js'
import type { MetaGraphClient } from '../src/services/meta-client.js'

/**
 * Workers have no boot-time validation (src/node.ts runs validateEnv only on
 * Node), so the variables arrive as bindings on each request. Each surface checks
 * the optional variables it reads and answers 503 instead of silently falling back.
 */
const KEY = 'wk_test_0123456789abcdef0123456789abcdef'
const BINDINGS = {
  WATAHUB_API_KEY: KEY,
  META_SYSTEM_USER_TOKEN: 'SYS',
  META_APP_SECRET: 'meta-app-secret',
  META_WEBHOOK_VERIFY_TOKEN: 'verify-token-0123456789',
}

function setup() {
  const errors: string[] = []
  const logger: Logger = { info: () => undefined, error: (message) => errors.push(message) }
  const client = {
    listTemplates: () => Promise.resolve({ data: [], paging: {} }),
  } as unknown as MetaGraphClient
  const app = createApp({
    logger,
    createMetaClient: () => client,
    fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) as unknown as typeof fetch,
  })
  return { app, errors }
}

const authed = { headers: { 'x-api-key': KEY } }

describe('optional env vars are validated on Workers', () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Only the bindings count: nothing from the Node environment leaks in
    process.env = {}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it.each([
    ['RATE_LIMIT_PER_MINUTE', 'abc', '/v1/templates/456', authed],
    ['TRUSTED_CLIENT_IP_HEADER', 'X Real IP', '/v1/templates/456', authed],
    ['META_API_VERSION', '24', '/v1/templates/456', authed],
    ['META_API_VERSION', '24', '/v24.0/789', authed],
    ['RATE_LIMIT_PER_MINUTE', '0', '/v24.0/789', authed],
    ['TRUSTED_CLIENT_IP_HEADER', 'X Real IP', '/v24.0/789', authed],
    ['CORS_ALLOWED_ORIGINS', '*', '/health', {}],
  ] as const)('%s=%s answers 503 on %s and logs the name, not the value', async (name, value, path, init) => {
    const { app, errors } = setup()
    const res = await app.request(path, init, { ...BINDINGS, [name]: value })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: `Gateway misconfigured: invalid ${name}` })
    expect(errors).toEqual([`[watahub] Invalid configuration (${name}); answering 503`])
  })

  it.each([
    ['WEBHOOK_DELIVERY_MODE', 'asinc'],
    ['META_WEBHOOK_MAX_AGE_SECONDS', '-5'],
  ])('%s=%s answers 503 to a Meta delivery so Meta retries', async (name, value) => {
    const { app } = setup()
    const res = await app.request('/webhook', { method: 'POST', body: '{}' }, { ...BINDINGS, [name]: value })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: `Gateway misconfigured: invalid ${name}` })
  })

  const SUBSCRIBER = {
    SUBSCRIBER_WEBHOOK_URL: 'https://agent.example.com/hook',
    SUBSCRIBER_WEBHOOK_SECRET: 's'.repeat(32),
  }

  it.each([
    ['SUBSCRIBER_WEBHOOK_URL', 'http://agent.example.com/hook'],
    ['SUBSCRIBER_WEBHOOK_URL', 'not a url'],
    ['SUBSCRIBER_WEBHOOK_SECRET', 'short-secret'],
  ])('%s=%s answers 503 to a Meta delivery before anything is forwarded', async (name, value) => {
    const { app, errors } = setup()
    const res = await app.request(
      '/webhook',
      { method: 'POST', body: '{}' },
      { ...BINDINGS, ...SUBSCRIBER, [name]: value }
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: `Gateway misconfigured: invalid ${name}` })
    expect(errors).toEqual([`[watahub] Invalid configuration (${name}); answering 503`])
  })

  it.each(['http://localhost:4000/hook', 'http://127.0.0.1:4000/hook'])(
    'accepts %s as a development subscriber URL',
    async (url) => {
      const { app } = setup()
      // Unsigned body: getting past the configuration check means 401, not 503
      const res = await app.request(
        '/webhook',
        { method: 'POST', body: '{}' },
        { ...BINDINGS, ...SUBSCRIBER, SUBSCRIBER_WEBHOOK_URL: url }
      )
      expect(res.status).toBe(401)
    }
  )

  it.each(['short-token', 'your_secure_verify_token_here'])(
    'META_WEBHOOK_VERIFY_TOKEN=%s answers 503 to the handshake, even with the matching token',
    async (token) => {
      const { app } = setup()
      const res = await app.request(
        `/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=c1`,
        {},
        { ...BINDINGS, META_WEBHOOK_VERIFY_TOKEN: token }
      )
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'Gateway misconfigured: invalid META_WEBHOOK_VERIFY_TOKEN' })
    }
  )

  it('leaves surfaces that do not read a variable alone', async () => {
    const { app } = setup()
    const bad = { ...BINDINGS, WEBHOOK_DELIVERY_MODE: 'asinc', META_API_VERSION: '24' }
    const handshake = await app.request(
      '/webhook?hub.mode=subscribe&hub.verify_token=verify-token-0123456789&hub.challenge=c1',
      {},
      bad
    )
    expect(await handshake.text()).toBe('c1')
    expect((await app.request('/health', {}, bad)).status).toBe(200)
  })

  it('changes nothing when every value is valid', async () => {
    const { app } = setup()
    const valid = {
      ...BINDINGS,
      RATE_LIMIT_PER_MINUTE: '100',
      TRUSTED_CLIENT_IP_HEADER: 'X-Real-IP',
      META_API_VERSION: 'v24.0',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      ...SUBSCRIBER,
    }
    expect((await app.request('/v1/templates/456', authed, valid)).status).toBe(200)
    expect((await app.request('/health', {}, valid)).status).toBe(200)
    const handshake = await app.request(
      '/webhook?hub.mode=subscribe&hub.verify_token=verify-token-0123456789&hub.challenge=c2',
      {},
      valid
    )
    expect(await handshake.text()).toBe('c2')
  })
})
