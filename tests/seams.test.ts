import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createApp } from '../src/index.js'
import type { Logger } from '../src/logger.js'
import { signSubscriberPayload } from '../src/services/crypto.js'
import { deliverToSubscriber } from '../src/services/delivery.js'
import { MetaClient, type MetaClientConfig, type MetaGraphClient } from '../src/services/meta-client.js'
import { buildProxyTargetUrl } from '../src/routes/proxy.js'
import { backoffDelayMs, exponentialDelayMs, type RetryPolicy } from '../src/services/retry.js'
import { jsonResponse, metaError, postJson } from './helpers/fetch-mock.js'

/**
 * The collaborators createApp and the services accept (Meta client factory,
 * fetch, clock, logger, sleep) actually replace the defaults.
 */
const KEY = 'wk_test_0123456789abcdef0123456789abcdef'
const auth = { 'x-api-key': KEY }

function memoryLogger() {
  const lines = { info: [] as string[], error: [] as string[] }
  const logger: Logger = {
    info: (message) => lines.info.push(message),
    error: (message) => lines.error.push(message),
  }
  return { logger, lines }
}

const fakeClient = (overrides: Partial<MetaGraphClient>): MetaGraphClient => ({
  sendMessage: () => Promise.reject(new Error('not stubbed')),
  listTemplates: () => Promise.reject(new Error('not stubbed')),
  exchangeCodeForToken: () => Promise.reject(new Error('not stubbed')),
  subscribeAppToWaba: () => Promise.reject(new Error('not stubbed')),
  overridePhoneNumberCallback: () => Promise.reject(new Error('not stubbed')),
  getMediaUrl: () => Promise.reject(new Error('not stubbed')),
  uploadMedia: () => Promise.reject(new Error('not stubbed')),
  ...overrides,
})

describe('createApp dependency injection', () => {
  const originalEnv = process.env
  let globalFetch: MockInstance<typeof fetch>

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'SYS' }
    // Any call reaching the global fetch means an injected collaborator was bypassed
    globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global fetch used'))
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('builds Meta clients through the injected factory', async () => {
    const configs: MetaClientConfig[] = []
    const sendMessage = vi.fn<MetaGraphClient['sendMessage']>().mockResolvedValue({
      success: true,
      messageId: 'fake',
      recipient: '1',
      phoneNumberId: '123',
    })
    const { logger } = memoryLogger()
    const app = createApp({
      logger,
      createMetaClient: (config) => {
        configs.push(config)
        return fakeClient({ sendMessage })
      },
    })

    const res = await app.request(
      '/v1/messages',
      postJson(
        { to: '1', phoneNumberId: '123', kind: 'text', text: { body: 'x' } },
        { ...auth, 'x-meta-access-token': 'TOK' }
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ messageId: 'fake' })
    expect(configs).toEqual([{ accessToken: 'TOK', apiVersion: 'v24.0' }])
    expect(sendMessage).toHaveBeenCalledWith('123', expect.objectContaining({ kind: 'text', to: '1' }))
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('routes every onboarding call through the injected client', async () => {
    process.env.META_APP_ID = '111'
    process.env.META_APP_SECRET = 'S'
    const client = fakeClient({
      exchangeCodeForToken: () => Promise.resolve({ accessToken: 'LONG' }),
      subscribeAppToWaba: () => Promise.resolve(true),
      overridePhoneNumberCallback: () => Promise.resolve(false),
      listTemplates: () => Promise.resolve([{ name: 'hello' }]),
      getMediaUrl: () => Promise.resolve('https://cdn.example/file.jpg'),
      uploadMedia: () => Promise.resolve({ id: 'MEDIA_SEAM_1' }),
    })
    const app = createApp({ logger: memoryLogger().logger, createMetaClient: () => client })

    const exchange = await app.request('/v1/onboarding/exchange', postJson({ code: 'C' }, auth))
    expect(await exchange.json()).toEqual({ accessToken: 'LONG' })
    const subscribe = await app.request('/v1/onboarding/subscribe', postJson({ wabaId: '456' }, auth))
    expect(await subscribe.json()).toEqual({ success: true, wabaId: '456' })
    const override = await app.request(
      '/v1/onboarding/override-callback',
      postJson({ phoneNumberId: '123', callbackUrl: 'https://cb.example', verifyToken: 'V' }, auth)
    )
    expect(await override.json()).toEqual({ success: false, phoneNumberId: '123' })
    const templates = await app.request('/v1/templates/456', { headers: auth })
    expect(await templates.json()).toEqual({ data: [{ name: 'hello' }] })
    const media = await app.request('/v1/media/123456', { headers: auth })
    expect(await media.json()).toEqual({ mediaId: '123456', url: 'https://cdn.example/file.jpg' })
    const upload = await app.request('/v1/media/123456', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'multipart/form-data; boundary=xyz' },
      body: 'stream',
    })
    expect(await upload.json()).toEqual({ id: 'MEDIA_SEAM_1' })
  })

  it('maps client failures on every route to generic 502/504 and logs only the error name', async () => {
    const timeout = Object.assign(new Error('timeout talking to 10.0.0.9'), { name: 'TimeoutError' })
    const failing = fakeClient({
      exchangeCodeForToken: () => Promise.reject(timeout),
      subscribeAppToWaba: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.9')),
      overridePhoneNumberCallback: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.9')),
      listTemplates: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.9')),
      getMediaUrl: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.9')),
    })
    process.env.META_APP_ID = '111'
    process.env.META_APP_SECRET = 'S'
    const { logger, lines } = memoryLogger()
    const app = createApp({ logger, createMetaClient: () => failing })

    const responses = await Promise.all([
      app.request('/v1/onboarding/exchange', postJson({ code: 'C' }, auth)),
      app.request('/v1/onboarding/subscribe', postJson({ wabaId: '456' }, auth)),
      app.request(
        '/v1/onboarding/override-callback',
        postJson({ phoneNumberId: '123', callbackUrl: 'https://cb.example', verifyToken: 'V' }, auth)
      ),
      app.request('/v1/templates/456', { headers: auth }),
      app.request('/v1/media/123', { headers: auth }),
    ])

    expect(responses.map((res) => res.status)).toEqual([504, 502, 502, 502, 502])
    for (const res of responses) expect(await res.text()).not.toContain('10.0.0.9')
    expect(lines.error.join('\n')).not.toContain('10.0.0.9')
    expect(lines.error).toContain('[watahub] Meta Graph API call failed: TimeoutError')
  })

  it('sends proxied Graph calls through the injected fetch', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ url: 'https://cdn/x' }))
    const app = createApp({ fetch: transport, logger: memoryLogger().logger })

    const res = await app.request('/v24.0/789?phone_number_id=123&fields=owner', { headers: auth })

    expect(res.status).toBe(200)
    expect(transport).toHaveBeenCalledWith(
      'https://graph.facebook.com/v24.0/789?phone_number_id=123',
      expect.objectContaining({ method: 'GET' })
    )
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('uses the injected clock for /health', async () => {
    const app = createApp({ now: () => Date.UTC(2030, 0, 2), logger: memoryLogger().logger })
    const body = (await (await app.request('/health')).json()) as { timestamp: string }
    expect(body.timestamp).toBe('2030-01-02T00:00:00.000Z')
  })

  it('stamps forwarded webhooks with the injected clock and fetch', async () => {
    process.env.META_APP_SECRET = 'APP'
    process.env.SUBSCRIBER_WEBHOOK_URL = 'https://subscriber.example/hook'
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'SUB'
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
    const app = createApp({ fetch: transport, now: () => 42_000, logger: memoryLogger().logger })
    const raw = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: 'D', phone_number_id: 'P' },
                messages: [{ id: 'wamid.1', from: '1', timestamp: 'garbage', type: 'text', text: { body: 'x' } }],
              },
            },
          ],
        },
      ],
    })

    const res = await app.request('/webhook', {
      method: 'POST',
      body: raw,
      headers: { 'x-hub-signature-256': await signSubscriberPayload(raw, 'APP') },
    })
    expect(res.status).toBe(200)

    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
    const forwarded = JSON.parse(String(transport.mock.calls[0][1]?.body)) as {
      timestamp: number
      events: Array<{ timestamp: number }>
    }
    expect(forwarded.timestamp).toBe(42_000)
    // Unparseable Meta timestamps fall back to the same clock
    expect(forwarded.events[0].timestamp).toBe(42_000)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('writes redacted request lines and unexpected errors to the injected logger', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-token-for-tests'
    process.env.META_APP_SECRET = 'APP'
    const { logger, lines } = memoryLogger()
    const app = createApp({ logger })

    await app.request('/webhook?hub.mode=subscribe&hub.verify_token=verify-token-for-tests&hub.challenge=1')
    expect(lines.info.join('\n')).toContain('hub.verify_token=[REDACTED]')
    expect(lines.info.join('\n')).not.toContain('verify-token-for-tests')

    const body = JSON.stringify({ entry: [null] })
    const res = await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': await signSubscriberPayload(body, 'APP') },
    })
    expect(res.status).toBe(500)
    expect(lines.error.some((line) => line.startsWith('[watahub-error] TypeError'))).toBe(true)
  })

  it('rejects the webhook handshake when no verify token is configured', async () => {
    delete process.env.META_WEBHOOK_VERIFY_TOKEN
    const app = createApp({ logger: memoryLogger().logger })
    const res = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')
    expect(res.status).toBe(403)
  })
})

describe('MetaClient collaborators', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, timeoutMs: 1_000 }

  it('waits through the injected sleep, capping Retry-After at maxDelayMs', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(metaError(130429)), { status: 429, headers: { 'Retry-After': '30' } })
      )
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.OK' }] }))
    const client = new MetaClient({ accessToken: 'T', fetch: transport, sleep, retry: policy })

    const result = await client.sendMessage('123', { to: '1', kind: 'text', text: { body: 'x' } })

    expect(result.messageId).toBe('wamid.OK')
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000)
  })

  it('treats a non-JSON success body as empty', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('not json', { status: 200 }))
    const client = new MetaClient({ accessToken: 'T', fetch: transport })
    expect(await client.listTemplates('456')).toEqual([])
  })

  it('drops non-object template entries returned by Graph', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [{ name: 'a' }, 'b', null, [1]] }))
    const client = new MetaClient({ accessToken: 'T', fetch: transport })
    expect(await client.listTemplates('456')).toEqual([{ name: 'a' }])
  })
})

describe('deliverToSubscriber collaborators', () => {
  const policy = { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 1_000, timeoutMs: 1_000 }
  const request = { url: 'https://subscriber.example/hook', body: '{}', secret: 's', deliveryId: 'id-1' }

  it('uses the injected fetch, sleep and logger', async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connect ECONNREFUSED 10.0.0.9'))
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)
    const { logger, lines } = memoryLogger()

    const result = await deliverToSubscriber(request, policy, { fetch: transport, sleep, logger })

    expect(result).toEqual({ delivered: false, attempts: 2, status: undefined })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250)
    expect(lines.error.at(-1)).toBe('[watahub] Giving up on subscriber delivery id-1 after 2 attempts')
    expect(lines.error.join('\n')).not.toContain('10.0.0.9')
  })

  it('reports the last HTTP status when giving up', async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response('', { status: 503 })))
    const { logger, lines } = memoryLogger()
    const sleep = () => Promise.resolve()

    const result = await deliverToSubscriber(request, policy, { fetch: transport, sleep, logger })

    expect(result).toEqual({ delivered: false, attempts: 2, status: 503 })
    expect(lines.error.at(-1)).toContain('(last HTTP 503)')
  })
})

describe('retry delays', () => {
  const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000, timeoutMs: 1 }

  it('grows exponentially up to maxDelayMs', () => {
    expect([0, 1, 2, 3, 4, 5].map((attempt) => exponentialDelayMs(attempt, policy))).toEqual([
      100, 200, 400, 800, 1_000, 1_000,
    ])
  })

  it('applies full jitter over the exponential ceiling', () => {
    expect(backoffDelayMs(3, policy, () => 0)).toBe(0)
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(400)
    expect(backoffDelayMs(10, policy, () => 0.999)).toBe(999)
  })
})

describe('buildProxyTargetUrl', () => {
  it('keeps only allowlisted query params', () => {
    expect(buildProxyTargetUrl('789', 'http://gw/v24.0/789')).toBe('https://graph.facebook.com/v24.0/789')
    expect(
      buildProxyTargetUrl('789', 'http://gw/v24.0/789?method=delete&phone_number_id=1&access_token=x&fields=a')
    ).toBe('https://graph.facebook.com/v24.0/789?phone_number_id=1')
  })
})

describe('Pluggable state stores in createApp', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, WATAHUB_API_KEY: KEY, META_SYSTEM_USER_TOKEN: 'SYS' }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('uses injected replayStore on webhook ingestion', async () => {
    const replayStore = {
      has: vi.fn().mockReturnValue(false),
      remember: vi.fn().mockReturnValue(true),
      clear: vi.fn(),
    }
    const app = createApp({ replayStore })

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [] }],
    })
    process.env.META_APP_SECRET = 'secret'

    const res = await app.request('/webhook', {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': await signSubscriberPayload(payload, 'secret'),
      },
    })
    expect(res.status).toBe(200)
    expect(replayStore.has).toHaveBeenCalled()
    expect(replayStore.remember).toHaveBeenCalled()
  })

  it('uses injected apiKeyLimiter on authentication failures', async () => {
    const apiKeyLimiter = {
      blockedFor: vi.fn().mockReturnValue(0),
      hit: vi.fn(),
      clear: vi.fn(),
    }
    const app = createApp({ apiKeyLimiter })

    const res = await app.request('/v1/messages', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'wrong-key' },
    })
    expect(res.status).toBe(401)
    expect(apiKeyLimiter.blockedFor).toHaveBeenCalled()
    expect(apiKeyLimiter.hit).toHaveBeenCalled()
  })

  it('uses injected verifyTokenLimiter on webhook verification failure', async () => {
    const verifyTokenLimiter = {
      blockedFor: vi.fn().mockReturnValue(0),
      hit: vi.fn(),
      clear: vi.fn(),
    }
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'correct-token'
    const app = createApp({ verifyTokenLimiter })

    const res = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')
    expect(res.status).toBe(403)
    expect(verifyTokenLimiter.blockedFor).toHaveBeenCalled()
    expect(verifyTokenLimiter.hit).toHaveBeenCalled()
  })

  it('uses injected createRequestLimiter on authenticated routes', async () => {
    const customLimiter = {
      blockedFor: vi.fn().mockReturnValue(0),
      hit: vi.fn(),
      clear: vi.fn(),
    }
    process.env.RATE_LIMIT_PER_MINUTE = '60'
    const app = createApp({
      createRequestLimiter: vi.fn().mockReturnValue(customLimiter),
      createMetaClient: () => fakeClient({ listTemplates: () => Promise.resolve([]) }),
    })

    const res = await app.request('/v1/templates/123', { headers: auth })
    expect(res.status).toBe(200)
    expect(customLimiter.blockedFor).toHaveBeenCalled()
    expect(customLimiter.hit).toHaveBeenCalled()
  })

  it('uses injected phoneDirectory to resolve tokens on outbound messages', async () => {
    let usedToken = ''
    const customPhoneDirectory = {
      lookup: vi.fn().mockImplementation((id: string) => {
        if (id === '123456789') {
          return Promise.resolve({ accessToken: 'TENANT_TOKEN', tenantId: 'tenant-1' })
        }
        return Promise.resolve(null)
      }),
    }
    const app = createApp({
      phoneDirectory: customPhoneDirectory,
      createMetaClient: ({ accessToken }) => {
        usedToken = accessToken
        return fakeClient({
          sendMessage: () =>
            Promise.resolve({
              success: true,
              messageId: 'wamid.123',
              recipient: '+15551234567',
              phoneNumberId: '123456789',
            }),
        })
      },
    })

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: '+15551234567',
        phoneNumberId: '123456789',
        kind: 'text',
        text: { body: 'hello tenant' },
      }),
    })

    expect(res.status).toBe(200)
    expect(customPhoneDirectory.lookup).toHaveBeenCalledWith('123456789')
    expect(usedToken).toBe('TENANT_TOKEN')
  })
})

describe('Distributed store adapters (store-adapters.ts)', () => {
  class MockKv {
    public map = new Map<string, string>()
    get(key: string): Promise<string | null> {
      return Promise.resolve(this.map.get(key) ?? null)
    }
    set(key: string, value: string): Promise<void> {
      this.map.set(key, value)
      return Promise.resolve()
    }
  }

  it('DistributedReplayStore remembers and checks deduplication keys', async () => {
    const { DistributedReplayStore } = await import('../src/services/store-adapters.js')
    const kv = new MockKv()
    const store = new DistributedReplayStore(kv, 3600)

    expect(await store.has('delivery-1')).toBe(false)
    expect(await store.remember('delivery-1')).toBe(true)
    expect(await store.has('delivery-1')).toBe(true)
    expect(await store.remember('delivery-1')).toBe(false)
    await store.clear()
  })

  it('DistributedRateLimitStore tracks hits, blocks, and recovers after window', async () => {
    const { DistributedRateLimitStore } = await import('../src/services/store-adapters.js')
    const kv = new MockKv()
    const store = new DistributedRateLimitStore(kv, 2, 60)

    expect(await store.blockedFor('client-ip', 1000)).toBe(0)
    await store.hit('client-ip', 1000)
    expect(await store.blockedFor('client-ip', 1000)).toBe(0)
    await store.hit('client-ip', 1000)

    // At limit
    expect(await store.blockedFor('client-ip', 1000)).toBe(60)

    // Expired
    expect(await store.blockedFor('client-ip', 1000 + 61_000)).toBe(0)

    // Overwritten with corrupted JSON recovers gracefully
    kv.map.set('watahub:ratelimit:client-ip', 'not-valid-json')
    expect(await store.blockedFor('client-ip', 1000)).toBe(0)
    await store.hit('client-ip', 1000)
    expect(await store.blockedFor('client-ip', 1000)).toBe(0)
    await store.clear()
  })

  it('DistributedPhoneDirectory sets, looks up, handles invalid JSON and deletes', async () => {
    const { DistributedPhoneDirectory } = await import('../src/services/store-adapters.js')
    class MockDeletableKv extends MockKv {
      delete(key: string): Promise<void> {
        this.map.delete(key)
        return Promise.resolve()
      }
    }
    const kv = new MockDeletableKv()
    const dir = new DistributedPhoneDirectory(kv)

    expect(await dir.lookup('123456')).toBeNull()

    await dir.set('123456', { accessToken: 'token-abc', tenantId: 'tenant-9' })
    const lookedUp = await dir.lookup('123456')
    expect(lookedUp).toEqual({ accessToken: 'token-abc', tenantId: 'tenant-9' })

    // Malformed JSON returns null
    kv.map.set('watahub:phone:123456', 'corrupted-json{')
    expect(await dir.lookup('123456')).toBeNull()

    // Delete phone config
    await dir.delete('123456')
    expect(await dir.lookup('123456')).toBeNull()
  })
})

describe('InMemoryPhoneDirectory (phone-directory.ts)', () => {
  it('supports initial config, lookup, set, delete, and clear', async () => {
    const { InMemoryPhoneDirectory } = await import('../src/services/phone-directory.js')
    const dir = new InMemoryPhoneDirectory({
      '111': { accessToken: 'token-111', tenantId: 'tenant-a' },
    })

    expect(await dir.lookup('111')).toEqual({ accessToken: 'token-111', tenantId: 'tenant-a' })
    expect(await dir.lookup('999')).toBeNull()

    dir.set('222', { accessToken: 'token-222', subscriberUrl: 'https://tenant-b.example/hook' })
    expect(dir.get('222')?.subscriberUrl).toBe('https://tenant-b.example/hook')

    expect(dir.delete('111')).toBe(true)
    expect(await dir.lookup('111')).toBeNull()

    dir.clear()
    expect(await dir.lookup('222')).toBeNull()

    // Map initialization
    const fromMap = new InMemoryPhoneDirectory(new Map([['333', { accessToken: 'token-333' }]]))
    expect(await fromMap.lookup('333')).toEqual({ accessToken: 'token-333' })
  })
})
