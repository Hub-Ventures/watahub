import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from '../src/index.js'
import { deliverToSubscriber, type DeliveryPolicy } from '../src/services/delivery.js'
import { sha256Hex, signSubscriberPayload } from '../src/services/crypto.js'
import { webhookDeliveryIds } from '../src/services/replay.js'

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
              messages: [{ from: '57300', id: 'wamid.A', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'x' } }],
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
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': await signSubscriberPayload(body, APP_SECRET) },
    })
  }

  beforeEach(() => {
    process.env = { ...originalEnv, META_APP_SECRET: APP_SECRET, SUBSCRIBER_WEBHOOK_URL: 'https://subscriber.example/hook' }
    webhookDeliveryIds.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('answers Meta 200 on Node (no ExecutionContext) and forwards with a body-derived delivery id', async () => {
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    const res = await deliver()
    expect(res.status).toBe(200)

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['x-watahub-delivery-id']).toBe(await sha256Hex(body))
  })

  it('a Meta redelivery of the same payload is acknowledged but forwarded only once', async () => {
    process.env.SUBSCRIBER_WEBHOOK_SECRET = 'sub-secret'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    await deliver()
    const second = await deliver()
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ status: 'ignored', reason: 'duplicate' })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not forward unsigned events when SUBSCRIBER_WEBHOOK_SECRET is missing', async () => {
    delete process.env.SUBSCRIBER_WEBHOOK_SECRET
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await deliver()
    expect(res.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
