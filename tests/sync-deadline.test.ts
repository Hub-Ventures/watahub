import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from '../src/index.js'
import { signSubscriberPayload } from '../src/services/crypto.js'
import { DEFAULT_DELIVERY_POLICY, SYNC_DELIVERY_POLICY } from '../src/services/delivery.js'
import { DeliveryIdCache } from '../src/services/replay.js'

/**
 * Synchronous delivery runs inside Meta's request, so it gets one short attempt
 * and no internal retries: a slow or failing subscriber answers 503 fast and Meta
 * retries, instead of holding Meta's request for up to ~18 s.
 */
const APP_SECRET = 'meta-app-secret'

function body(text: string) {
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

async function post(app: ReturnType<typeof createApp>, raw: string) {
  return app.request('/webhook', {
    method: 'POST',
    body: raw,
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': await signSubscriberPayload(raw, APP_SECRET),
    },
  })
}

describe('synchronous delivery deadline', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      META_APP_SECRET: APP_SECRET,
      SUBSCRIBER_WEBHOOK_URL: 'https://subscriber.example/hook',
      SUBSCRIBER_WEBHOOK_SECRET: 's'.repeat(32),
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('makes one attempt of 3 s and no internal retries; background delivery keeps its retries', () => {
    expect(SYNC_DELIVERY_POLICY).toMatchObject({ maxAttempts: 1, timeoutMs: 3_000 })
    expect(DEFAULT_DELIVERY_POLICY).toMatchObject({ maxAttempts: 3, timeoutMs: 5_000 })
  })

  it('answers 503 within the deadline when the subscriber does not answer, after a single attempt', async () => {
    // A subscriber that never answers: the request only ends when its signal aborts
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')))
        })
    )
    const app = createApp({ fetch: fetchSpy as unknown as typeof fetch, replayStore: new DeliveryIdCache() })

    const started = Date.now()
    const res = await post(app, body('slow'))
    const elapsed = Date.now() - started

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'Subscriber delivery failed', attempts: 1 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeGreaterThanOrEqual(2_900)
    expect(elapsed).toBeLessThan(4_500)
  }, 10_000)

  it.each([400, 403, 404, 422])(
    'acknowledges a final %i from the subscriber with 200, logs it and marks the body seen',
    async (status) => {
      const errors: string[] = []
      const fetchSpy = vi.fn().mockResolvedValue(new Response('no', { status }))
      const app = createApp({
        fetch: fetchSpy as unknown as typeof fetch,
        replayStore: new DeliveryIdCache(),
        logger: { info: () => undefined, error: (message) => errors.push(message) },
      })
      const raw = body(`rejected-${status}`)

      const res = await post(app, raw)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'rejected', subscriberStatus: status })
      expect(errors.some((line) => line.includes('rejected delivery') && line.includes(`HTTP ${status}`))).toBe(true)

      // Marked seen: Meta's redelivery is not forwarded again
      expect(await (await post(app, raw)).json()).toMatchObject({ status: 'ignored', reason: 'duplicate' })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    }
  )

  it.each([408, 425, 429])('keeps answering 503 to a retryable %i so Meta retries', async (status) => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('later', { status }))
    const app = createApp({ fetch: fetchSpy as unknown as typeof fetch, replayStore: new DeliveryIdCache() })
    const res = await post(app, body(`retryable-${status}`))
    expect(res.status).toBe(503)
  })

  it('does not retry a 5xx inside the request: one attempt, then 503 so Meta retries', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('down', { status: 500 }))
    const app = createApp({ fetch: fetchSpy as unknown as typeof fetch, replayStore: new DeliveryIdCache() })

    const started = Date.now()
    const res = await post(app, body('down'))

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ attempts: 1, subscriberStatus: 500 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // No backoff waits (1 s + 2 s before)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
