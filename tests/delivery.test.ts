import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app, { createApp } from '../src/index.js'
import { deliverToSubscriber, type DeliveryPolicy } from '../src/services/delivery.js'
import { sha256Hex, signSubscriberPayload } from '../src/services/crypto.js'
import { DeliveryIdCache, webhookDeliveryIds } from '../src/services/replay.js'

const FAST: DeliveryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 50 }
const request = { url: 'https://subscriber.example/hook', body: '{"a":1}', secret: 'sub-secret', deliveryId: 'abc123' }

describe('deliverToSubscriber', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('signs the body and sends a stable delivery id on every attempt', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const result = await deliverToSubscriber(request, FAST)
    expect(result).toEqual({ delivered: true, attempts: 2, status: 200 })

    const expectedSignature = await signSubscriberPayload(request.body, request.secret)
    for (const [, init] of fetchSpy.mock.calls) {
      const headers = init?.headers as Record<string, string>
      expect(headers['x-watahub-signature']).toBe(expectedSignature)
      expect(headers['x-watahub-delivery-id']).toBe('abc123')
      expect(headers['Idempotency-Key']).toBe('abc123')
    }
  })

  it('retries network errors and timeouts, then gives up after maxAttempts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const result = await deliverToSubscriber(request, FAST)
    expect(result.delivered).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('does not retry a permanent 4xx rejection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }))

    const result = await deliverToSubscriber(request, FAST)
    expect(result).toEqual({ delivered: false, attempts: 1, status: 400 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries 429 from the subscriber', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('slow', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 202 }))

    expect((await deliverToSubscriber(request, FAST)).delivered).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('deliverToSubscriber timedOut', () => {
  const ONE_SHORT: DeliveryPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 20 }
  const quiet = { info: () => undefined, error: () => undefined }

  /** A subscriber that never answers: the request ends only when the policy signal aborts it, as fetch does */
  const hang = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as DOMException))
    })

  it('is true when the attempt ends on the policy timeout', async () => {
    const result = await deliverToSubscriber(request, ONE_SHORT, { fetch: hang, logger: quiet })
    expect(result).toEqual({ delivered: false, attempts: 1, status: undefined, timedOut: true })
  })

  it('is absent after a network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const result = await deliverToSubscriber(request, ONE_SHORT, { fetch: fetchFn, logger: quiet })
    expect(result.delivered).toBe(false)
    expect(result).not.toHaveProperty('timedOut')
  })

  it.each([500, 503, 400, 307])('is absent after HTTP %i', async (status) => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(null, { status })))
    const result = await deliverToSubscriber(request, ONE_SHORT, { fetch: fetchFn, logger: quiet })
    expect(result).toMatchObject({ delivered: false, status })
    expect(result).not.toHaveProperty('timedOut')
  })

  it('describes the last attempt only', async () => {
    const policy: DeliveryPolicy = { ...FAST, maxAttempts: 2, timeoutMs: 20 }

    const timeoutThenStatus = vi
      .fn()
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
    const answered = await deliverToSubscriber(request, policy, { fetch: timeoutThenStatus, logger: quiet })
    expect(answered).toMatchObject({ delivered: false, attempts: 2, status: 502 })
    expect(answered).not.toHaveProperty('timedOut')

    const statusThenTimeout = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockImplementationOnce(hang)
    const timedOut = await deliverToSubscriber(request, policy, { fetch: statusThenTimeout, logger: quiet })
    expect(timedOut).toMatchObject({ delivered: false, attempts: 2, timedOut: true })
    expect(timedOut.status).toBeUndefined()
  })
})

describe('deliverToSubscriber redirects', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not follow redirects and treats them as a final failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } }))

    const result = await deliverToSubscriber(request, FAST)
    expect(result).toEqual({ delivered: false, attempts: 1, status: 307 })
    expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('manual')
  })
})

describe('POST /webhook → subscriber forwarding', () => {
  const originalEnv = process.env
  const APP_SECRET = 'meta-app-secret'
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1555', phone_number_id: '987' },
              messages: [
                {
                  from: '57300',
                  id: 'wamid.A',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'x' },
                },
              ],
            },
          },
        ],
      },
    ],
  })

  async function deliver() {
    return app.request('/webhook', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': await signSubscriberPayload(body, APP_SECRET),
      },
    })
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      META_APP_SECRET: APP_SECRET,
      SUBSCRIBER_WEBHOOK_URL: 'https://subscriber.example/hook',
    }
    webhookDeliveryIds.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('answers Meta 200 on Node (no ExecutionContext) and forwards with a body-derived delivery id', async () => {
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret-0123456789abcdef0123456789'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    const res = await deliver()
    expect(res.status).toBe(200)

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['x-watahub-delivery-id']).toBe(await sha256Hex(body))
  })

  it('a Meta redelivery of the same payload is acknowledged but forwarded only once', async () => {
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret-0123456789abcdef0123456789'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    await deliver()
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await deliver()
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ status: 'ignored', reason: 'duplicate' })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('answers 503 (so Meta retries) instead of dropping events when SUBSCRIBER_WEBHOOK_SECRET is missing', async () => {
    delete process.env.SUBSCRIBER_WEBHOOK_SECRET
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await deliver()
    expect(res.status).toBe(503)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers 503 (so Meta retries) when subscriber delivery fails in sync mode', async () => {
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret-0123456789abcdef0123456789'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('server error', { status: 500 }))

    const res = await deliver()
    expect(res.status).toBe(503)
    const data = (await res.json()) as Record<string, unknown>
    expect(data.error).toBe('Subscriber delivery failed')
  })

  it('supports WEBHOOK_DELIVERY_MODE=async and catches async dispatch errors', async () => {
    process.env.WEBHOOK_DELIVERY_MODE = 'async'
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret-0123456789abcdef0123456789'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'))

    const res = await deliver()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'received' })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled())
  })

  it('forwards non-messages webhook changes (like history sync) with raw payload to subscriber', async () => {
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret-0123456789abcdef0123456789'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    const historyPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'history',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123' },
                history_data: { phase: 0, chunk_order: 1, progress: 25 },
              },
            },
          ],
        },
      ],
    })

    const res = await app.request('/webhook', {
      method: 'POST',
      body: historyPayload,
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': await signSubscriberPayload(historyPayload, APP_SECRET),
      },
    })
    expect(res.status).toBe(200)

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
    expect(sentBody.events).toEqual([])
    expect(sentBody.raw).toEqual(JSON.parse(historyPayload))
  })

  it('forwards smb_message_echoes webhook with normalized echo event', async () => {
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret-0123456789abcdef0123456789'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    const echoPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '1555', phone_number_id: '987' },
                message_echoes: [
                  {
                    from: '1555',
                    to: '57300',
                    id: 'wamid.echo_1',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hello from WhatsApp mobile app' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    const res = await app.request('/webhook', {
      method: 'POST',
      body: echoPayload,
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': await signSubscriberPayload(echoPayload, APP_SECRET),
      },
    })
    expect(res.status).toBe(200)

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
    expect(sentBody.events).toHaveLength(1)
    expect(sentBody.events[0].type).toBe('echo')
    expect(sentBody.events[0].message).toMatchObject({
      id: 'wamid.echo_1',
      from: '1555',
      recipient: '57300',
      isEcho: true,
      kind: 'text',
      text: 'Hello from WhatsApp mobile app',
    })
  })
})

describe('POST /webhook async delivery that fails for good', () => {
  const originalEnv = process.env
  const APP_SECRET = 'meta-app-secret'
  const ONLY_IN_LOG = 'WEBHOOK_DELIVERY_MODE=async does not ask Meta to retry, so the event is only in this log'

  function messageBody(text: string) {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '1555', phone_number_id: '987' },
                messages: [
                  {
                    from: '57300',
                    id: `wamid.${text}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    })
  }

  function appWith(fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    const errors: string[] = []
    const gateway = createApp({
      fetch: fetchFn,
      replayStore: new DeliveryIdCache(),
      logger: { info: () => undefined, error: (message) => errors.push(message) },
    })
    return { gateway, errors }
  }

  async function post(gateway: ReturnType<typeof createApp>, raw: string) {
    return gateway.request('/webhook', {
      method: 'POST',
      body: raw,
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': await signSubscriberPayload(raw, APP_SECRET),
      },
    })
  }

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      META_APP_SECRET: APP_SECRET,
      SUBSCRIBER_WEBHOOK_URL: 'https://subscriber.example/hook',
      SUBSCRIBER_WEBHOOK_SECRET: 's'.repeat(32),
      WEBHOOK_DELIVERY_MODE: 'async',
    }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('logs that the event is only in the log after the last retry fails', async () => {
    // The backoff between attempts (1 s, then 2 s) waits on setTimeout
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const fetchFn = vi.fn(() => Promise.resolve(new Response('down', { status: 500 })))
    const { gateway, errors } = appWith(fetchFn)
    const raw = messageBody('async-gives-up')

    const res = await post(gateway, raw)
    expect(res.status).toBe(200)

    const gaveUp = () => errors.some((line) => line.includes(ONLY_IN_LOG))
    for (let step = 0; step < 40 && !gaveUp(); step++) await vi.advanceTimersByTimeAsync(250)

    expect(fetchFn).toHaveBeenCalledTimes(3)
    const lines = errors.filter((line) => line.includes(ONLY_IN_LOG))
    expect(lines).toEqual([`[watahub] Delivery ${await sha256Hex(raw)} failed for good; ${ONLY_IN_LOG}`])
  })

  it('logs it after a redirect, which is not the subscriber refusing the event', async () => {
    const { gateway, errors } = appWith(() => Promise.resolve(new Response(null, { status: 307 })))

    expect((await post(gateway, messageBody('async-redirect'))).status).toBe(200)
    await vi.waitFor(() => expect(errors.some((line) => line.includes(ONLY_IN_LOG))).toBe(true))
  })

  it.each([400, 404, 422])('does not log it after a final %i: the subscriber refused the event', async (status) => {
    const { gateway, errors } = appWith(() => Promise.resolve(new Response('no', { status })))

    expect((await post(gateway, messageBody(`async-final-${status}`))).status).toBe(200)
    await vi.waitFor(() => expect(errors.some((line) => line.includes(`HTTP ${status}`))).toBe(true))
    // The give-up line would follow the rejection in the same background task
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(errors.some((line) => line.includes(ONLY_IN_LOG))).toBe(false)
  })

  it('does not log it when the delivery succeeds', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })))
    const { gateway, errors } = appWith(fetchFn)

    expect((await post(gateway, messageBody('async-ok'))).status).toBe(200)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(errors).toEqual([])
  })
})
