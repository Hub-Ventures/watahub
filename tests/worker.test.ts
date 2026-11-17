import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ExecutionContext } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { cloudflareKvStore, createApp, MemoryLineStore, type KvNamespaceLike } from '../src/index.js'

const KEY = 'k'.repeat(48)
const APP_SECRET = 'gateway-app-secret'
const PHONE = '770000000000001'
const WABA = '770000000000002'
const BIZ = 'BIZ_LINE_TOKEN'
const LINE_KEY = `watahub:line:${PHONE}`

/** Worker bindings: on Workers every variable comes from `env`, not process.env */
const bindings = { WATAHUB_API_KEY: KEY, META_APP_ID: '111', META_APP_SECRET: APP_SECRET }
const connectBody = { code: 'line-code', wabaId: WABA, phoneNumberId: PHONE, pin: '581063' }
const sendBody = { to: '15551234567', phoneNumberId: PHONE, kind: 'text', text: { body: 'hi' } }

function fakeKv() {
  const data = new Map<string, string>()
  const namespace = {
    get: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    put: vi.fn((key: string, value: string, _options?: { expirationTtl?: number }) => {
      data.set(key, value)
      return Promise.resolve()
    }),
    delete: vi.fn((key: string) => {
      data.delete(key)
      return Promise.resolve()
    }),
  } satisfies KvNamespaceLike
  return { data, namespace }
}

function executionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify(body),
  })
}

function graphOk(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** For cases that must not reach Meta: a regression fails the test instead of going to the network. */
function blockMeta() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Meta must not be called'))
}

/** A fresh copy of src/worker.ts with its own module state: what a new Workers isolate loads. */
async function loadIsolate() {
  vi.resetModules()
  return (await import('../src/worker.js')).default
}

describe('cloudflareKvStore', () => {
  it('raises a TTL below 60 seconds to 60, the Cloudflare minimum', async () => {
    const { namespace } = fakeKv()
    const store = cloudflareKvStore(namespace)
    await store.set('a', '1', { ttlSeconds: 1 })
    await store.set('b', '1', { ttlSeconds: 59.5 })
    expect(namespace.put).toHaveBeenNthCalledWith(1, 'a', '1', { expirationTtl: 60 })
    expect(namespace.put).toHaveBeenNthCalledWith(2, 'b', '1', { expirationTtl: 60 })
  })

  it('keeps a TTL of 60 seconds or more', async () => {
    const { namespace } = fakeKv()
    await cloudflareKvStore(namespace).set('a', '1', { ttlSeconds: 3600 })
    expect(namespace.put).toHaveBeenCalledWith('a', '1', { expirationTtl: 3600 })
  })

  it('writes without an expiration when no TTL is given', async () => {
    const { namespace } = fakeKv()
    const store = cloudflareKvStore(namespace)
    await store.set('a', '1')
    await store.set('b', '1', {})
    expect(namespace.put).toHaveBeenNthCalledWith(1, 'a', '1')
    expect(namespace.put).toHaveBeenNthCalledWith(2, 'b', '1')
  })

  it('passes get and delete through', async () => {
    const { data, namespace } = fakeKv()
    data.set('a', 'value')
    const store = cloudflareKvStore(namespace)
    expect(await store.get('a')).toBe('value')
    expect(await store.get('missing')).toBeNull()
    await store.delete?.('a')
    expect(namespace.delete).toHaveBeenCalledWith('a')
    expect(data.has('a')).toBe(false)
  })
})

describe('Worker entry (src/worker.ts) on workerd', () => {
  const originalEnv = process.env
  let errors: string[]

  /** The startup line createWorkerApp logs when the binding is missing */
  const bindingErrors = () => errors.filter((line) => line.includes('WATAHUB_KV is not bound'))

  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    process.env = { ...originalEnv }
    for (const name of [...Object.keys(bindings), 'META_SYSTEM_USER_TOKEN']) delete process.env[name]
    errors = []
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      errors.push(line)
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.env = originalEnv
  })

  it('runs with the stubbed runtime', () => {
    expect(getRuntimeKey()).toBe('workerd')
  })

  it('stores the line in KV on connect, and another isolate sends with the stored token', async () => {
    const { data, namespace } = fakeKv()
    const env = { ...bindings, WATAHUB_KV: namespace }
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: BIZ }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ messages: [{ id: 'wamid.1' }] }))

    const isolateA = await loadIsolate()
    const connect = await isolateA.fetch(post('/v1/onboarding/connect', connectBody), env, executionContext())
    expect(connect.status).toBe(200)
    expect(JSON.stringify(await connect.json())).not.toContain(BIZ)
    expect(JSON.parse(data.get(LINE_KEY)!)).toEqual({ phoneNumberId: PHONE, wabaId: WABA, accessToken: BIZ })
    // A line token does not expire
    expect(namespace.put).toHaveBeenCalledWith(LINE_KEY, expect.any(String))

    const isolateB = await loadIsolate()
    expect(isolateB).not.toBe(isolateA)
    const send = await isolateB.fetch(post('/v1/messages', sendBody), env, executionContext())
    expect(send.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(new Headers((fetchSpy.mock.calls[3][1] as RequestInit).headers).get('authorization')).toBe(`Bearer ${BIZ}`)
    expect(bindingErrors()).toEqual([])
  })

  it('answers 503 on connect without WATAHUB_KV, never calls Meta and names the binding', async () => {
    const fetchSpy = blockMeta()
    const worker = await loadIsolate()

    const res = await worker.fetch(post('/v1/onboarding/connect', connectBody), bindings, executionContext())
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('WATAHUB_KV')
    expect(body.error).toContain('lineStore')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(bindingErrors()).toHaveLength(1)
    expect(errors.some((line) => line.includes('Refusing connect on Workers'))).toBe(true)
  })

  it.each([
    ['a plain var', 'a1b2c3d4e5f6'],
    ['an object without delete', { get: vi.fn(), put: vi.fn() }],
    ['null', null],
  ])('treats a WATAHUB_KV that is %s as missing and logs it', async (_label, value) => {
    const fetchSpy = blockMeta()
    const worker = await loadIsolate()

    const res = await worker.fetch(
      post('/v1/onboarding/connect', connectBody),
      { ...bindings, WATAHUB_KV: value },
      executionContext()
    )
    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(bindingErrors()).toHaveLength(1)
    if (value && typeof value === 'object') {
      expect(value.get).not.toHaveBeenCalled()
      expect(value.put).not.toHaveBeenCalled()
    }
  })

  it('builds the app once per isolate, from the first request', async () => {
    const worker = await loadIsolate()
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(new Request('http://localhost/health'), bindings, executionContext())
      expect(res.status).toBe(200)
    }
    expect(bindingErrors()).toHaveLength(1)

    // Bindings do not change inside an isolate, so a later env does not rebuild the app
    const { namespace } = fakeKv()
    const fetchSpy = blockMeta()
    const res = await worker.fetch(
      post('/v1/onboarding/connect', connectBody),
      { ...bindings, WATAHUB_KV: namespace },
      executionContext()
    )
    expect(res.status).toBe(503)
    expect(namespace.put).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(bindingErrors()).toHaveLength(1)
  })

  it('answers 503 on connect for createApp() with the default line store', async () => {
    const fetchSpy = blockMeta()
    const res = await createApp().fetch(post('/v1/onboarding/connect', connectBody), bindings)
    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still connects with a MemoryLineStore passed on purpose', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: BIZ }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ success: true }))
    const lineStore = new MemoryLineStore()

    const res = await createApp({ lineStore }).fetch(post('/v1/onboarding/connect', connectBody), bindings)
    expect(res.status).toBe(200)
    expect(lineStore.get(PHONE)?.accessToken).toBe(BIZ)
  })
})

describe('connect on Node', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, ...bindings }
    delete process.env.META_SYSTEM_USER_TOKEN
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env = originalEnv
  })

  it('still connects with the default line store', async () => {
    expect(getRuntimeKey()).toBe('node')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(graphOk({ access_token: BIZ }))
      .mockResolvedValueOnce(graphOk({ success: true }))
      .mockResolvedValueOnce(graphOk({ success: true }))

    const res = await createApp().fetch(post('/v1/onboarding/connect', connectBody))
    expect(res.status).toBe(200)
  })
})
