import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import app from '../src/index.js'
import { signSubscriberPayload } from '../src/services/crypto.js'
import { DeliveryIdCache, isStale, newestEventTimestamp, webhookDeliveryIds } from '../src/services/replay.js'
import type { MetaWebhookPayload } from '../src/types/meta.js'

const APP_SECRET = 'meta-app-secret'
const nowSeconds = () => Math.floor(Date.now() / 1000)

function payloadAt(messageTs: number, statusTs?: number): MetaWebhookPayload {
  const value: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '1555', phone_number_id: '987' },
    messages: [{ from: '57300', id: `wamid.${messageTs}`, timestamp: String(messageTs), type: 'text', text: { body: 'x' } }],
  }
  if (statusTs) value.statuses = [{ id: 'wamid.S', status: 'read', timestamp: String(statusTs), recipient_id: '57300' }]
  return { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value }] }] } as unknown as MetaWebhookPayload
}

async function postSigned(payload: MetaWebhookPayload) {
  const body = JSON.stringify(payload)
  return app.request('/webhook', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': await signSubscriberPayload(body, APP_SECRET) },
  })
}

describe('replay helpers', () => {
  it('finds the newest message or status timestamp', () => {
    expect(newestEventTimestamp(payloadAt(100, 250))).toBe(250)
    expect(newestEventTimestamp({ object: 'x', entry: [] } as unknown as MetaWebhookPayload)).toBeUndefined()
  })

  it('ignores old timestamps outside the messages field (history sync)', () => {
    const history = payloadAt(1_000)
    ;(history.entry[0].changes[0] as { field: string }).field = 'history'
    expect(newestEventTimestamp(history)).toBeUndefined()
    expect(isStale(history, 60)).toBe(false)
  })

  it('treats payloads without event timestamps as fresh', () => {
    const noEvents = { object: 'x', entry: [{ id: '1', changes: [{ field: 'message_template_status_update', value: {} }] }] }
    expect(isStale(noEvents as unknown as MetaWebhookPayload, 60)).toBe(false)
  })

  it('ages by the newest event, so a batch with one fresh event is not stale', () => {
    const now = Date.now()
    expect(isStale(payloadAt(now / 1000 - 3600), 60, now)).toBe(true)
    expect(isStale(payloadAt(now / 1000 - 3600, now / 1000 - 10), 60, now)).toBe(false)
  })

  it('remembers delivery ids inside the TTL and forgets them after', () => {
    const cache = new DeliveryIdCache(1_000, 10)
    expect(cache.remember('a', 0)).toBe(true)
    expect(cache.remember('a', 500)).toBe(false)
    expect(cache.remember('a', 1_500)).toBe(true)
  })

  it('stays bounded when full', () => {
    const cache = new DeliveryIdCache(60_000, 3)
    for (const id of ['a', 'b', 'c', 'd']) cache.remember(id, 0)
    // 'a' was evicted to make room, so it is accepted again
    expect(cache.remember('a', 1)).toBe(true)
    expect(cache.remember('d', 1)).toBe(false)
  })
})

describe('POST /webhook replay protection', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      META_APP_SECRET: APP_SECRET,
      SUBSCRIBER_WEBHOOK_URL: 'https://subscriber.example/hook',
      SUBSCRIBER_WEBHOOK_SECRET: 's'.repeat(32),
    }
    webhookDeliveryIds.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('acknowledges but does not forward a signed delivery older than the window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const eightDaysAgo = nowSeconds() - 8 * 24 * 3600

    const res = await postSigned(payloadAt(eightDaysAgo))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ignored', reason: 'stale' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('honors META_WEBHOOK_MAX_AGE_SECONDS', async () => {
    process.env.META_WEBHOOK_MAX_AGE_SECONDS = '300'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    const old = await postSigned(payloadAt(nowSeconds() - 600))
    expect(await old.json()).toMatchObject({ reason: 'stale' })

    const fresh = await postSigned(payloadAt(nowSeconds() - 60))
    expect(await fresh.json()).toMatchObject({ status: 'received', eventsCount: 1 })
    // Let the background forward settle before the next test installs its own fetch spy
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
  })

  it('forwards an identical signed body only once', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const payload = payloadAt(nowSeconds())

    expect(await (await postSigned(payload)).json()).toMatchObject({ status: 'received' })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await (await postSigned(payload)).json()).toMatchObject({ status: 'ignored', reason: 'duplicate' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('lets a body whose delivery failed be replayed', async () => {
    // 400 is final for the subscriber client, so one attempt and no backoff wait
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }))
    const payload = payloadAt(nowSeconds())

    await postSigned(payload)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await (await postSigned(payload)).json()).toMatchObject({ status: 'received' })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
  })

  it('remembers bodies that had nothing to forward', async () => {
    delete process.env.SUBSCRIBER_WEBHOOK_URL
    const payload = payloadAt(nowSeconds())
    expect(await (await postSigned(payload)).json()).toMatchObject({ status: 'received' })
    expect(await (await postSigned(payload)).json()).toMatchObject({ reason: 'duplicate' })
  })

  it('does not let unsigned bodies poison the duplicate cache', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const payload = payloadAt(nowSeconds())

    const forged = await app.request('/webhook', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } })
    expect(forged.status).toBe(401)

    expect(await (await postSigned(payload)).json()).toMatchObject({ status: 'received' })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
  })
})
