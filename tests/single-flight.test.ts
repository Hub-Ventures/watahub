import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp } from '../src/index.js'
import { signSubscriberPayload } from '../src/services/crypto.js'
import { DeliveryIdCache } from '../src/services/replay.js'

/**
 * Meta delivers in parallel and retries, so two copies of one body can arrive while
 * the first is still being delivered. Only one may reach the subscriber.
 */
const APP_SECRET = 'meta-app-secret'
const nowSeconds = () => Math.floor(Date.now() / 1000)

function body(text = 'hola') {
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
                  timestamp: String(nowSeconds()),
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

/** A subscriber that answers only when the test releases it */
function slowSubscriber(status = 200) {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetchSpy = vi.fn(async () => {
    await gate
    return new Response('ok', { status })
  })
  return { fetchSpy, release }
}

function gateway(fetchSpy: unknown) {
  return createApp({ fetch: fetchSpy as typeof fetch, replayStore: new DeliveryIdCache() })
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

describe('one delivery per body in flight', () => {
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

  it('delivers two simultaneous copies once, and answers both with 200', async () => {
    const { fetchSpy, release } = slowSubscriber()
    const app = gateway(fetchSpy)
    const raw = body()

    const first = post(app, raw)
    const second = post(app, raw)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    release()

    const [a, b] = await Promise.all([first, second])
    expect([a.status, b.status]).toEqual([200, 200])
    // Both requests race to the gateway, so either one may be the copy that delivers
    const outcomes = [(await a.json()) as { status: string }, (await b.json()) as { status: string }]
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['ignored', 'received'])
    expect(outcomes.find((outcome) => outcome.status === 'ignored')).toMatchObject({ reason: 'duplicate' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('answers 503 to both copies when the first delivery fails, and leaves the body unmarked', async () => {
    // 400 is final for the subscriber client: one attempt, no backoff wait
    const { fetchSpy, release } = slowSubscriber(400)
    const app = gateway(fetchSpy)
    const raw = body('falla')

    const first = post(app, raw)
    const second = post(app, raw)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    release()

    const [a, b] = await Promise.all([first, second])
    expect([a.status, b.status]).toEqual([503, 503])
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Meta's retry is delivered: the failed body was not marked as seen
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }))
    expect((await post(app, raw)).status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('in async mode answers the second copy 200 without delivering it again', async () => {
    process.env.WEBHOOK_DELIVERY_MODE = 'async'
    const { fetchSpy, release } = slowSubscriber()
    const app = gateway(fetchSpy)
    const raw = body('async')

    expect(await (await post(app, raw)).json()).toMatchObject({ status: 'received' })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    expect(await (await post(app, raw)).json()).toMatchObject({ status: 'ignored', reason: 'duplicate' })
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps the in-flight set per app, so two apps do not share it', async () => {
    const one = slowSubscriber()
    const two = slowSubscriber()
    const raw = body('apps')

    const first = post(gateway(one.fetchSpy), raw)
    const second = post(gateway(two.fetchSpy), raw)
    await vi.waitFor(() => expect(one.fetchSpy).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(two.fetchSpy).toHaveBeenCalledTimes(1))
    one.release()
    two.release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
  })
})
