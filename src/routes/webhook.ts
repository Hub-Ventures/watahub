import { Hono } from 'hono'
import { getEnvVar } from '../utils/env.js'
import { verifyMetaSignature, sha256Hex, timingSafeEqual } from '../services/crypto.js'
import { deliverToSubscriber } from '../services/delivery.js'
import { normalizeMetaWebhook } from '../services/normalizer.js'
import { DEFAULT_WEBHOOK_MAX_AGE_SECONDS, isStale, webhookDeliveryIds } from '../services/replay.js'
import { clientAddress, tooManyRequests, verifyTokenFailures } from '../middleware/rate-limit.js'
import type { MetaWebhookPayload } from '../types/meta.js'

export const webhookRouter = new Hono()

/**
 * Meta Webhook Verification Handshake
 * GET /webhook
 */
webhookRouter.get('/webhook', async (c) => {
  const query = c.req.query()
  const mode = query['hub.mode']
  const token = query['hub.verify_token']
  const challenge = query['hub.challenge']

  const expectedToken = getEnvVar(c, 'META_WEBHOOK_VERIFY_TOKEN')

  if (mode === 'subscribe' && token && expectedToken && (await timingSafeEqual(token, expectedToken))) {
    return c.text(challenge || '', 200)
  }

  // Throttle guessing on this public route; the correct token is never refused (see requireApiKey)
  const client = clientAddress(c)
  const retryAfter = verifyTokenFailures.blockedFor(client)
  if (retryAfter > 0) return tooManyRequests(c, retryAfter)
  verifyTokenFailures.hit(client)
  return c.text('Forbidden: Webhook verification failed', 403)
})

/**
 * Meta Webhook Ingestion & Subscriber Forwarding
 * POST /webhook
 */
webhookRouter.post('/webhook', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('x-hub-signature-256')
  const appSecret = getEnvVar(c, 'META_APP_SECRET')

  // Fail closed: without META_APP_SECRET there is no way to authenticate Meta,
  // so unsigned payloads must never be accepted or forwarded.
  if (!appSecret) {
    console.error('[watahub] META_APP_SECRET is not set; rejecting webhook delivery')
    return c.json({ error: 'Gateway misconfigured: webhook signature secret is not set' }, 503)
  }

  const isValid = await verifyMetaSignature(rawBody, signature, appSecret)
  if (!isValid) {
    return c.json({ error: 'Invalid HMAC signature' }, 401)
  }

  let payload: MetaWebhookPayload
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  // Derived from Meta's signed raw body, so a Meta redelivery of the same
  // payload produces the same ID and the subscriber can drop the duplicate
  const deliveryId = await sha256Hex(rawBody)

  // Replay protection (src/services/replay.ts). Both cases answer 200 so Meta
  // stops retrying, but nothing is forwarded.
  const maxAgeSeconds = Number(getEnvVar(c, 'META_WEBHOOK_MAX_AGE_SECONDS')) || DEFAULT_WEBHOOK_MAX_AGE_SECONDS
  if (isStale(payload, maxAgeSeconds)) {
    console.error(`[watahub] Ignoring webhook ${deliveryId}: events older than ${maxAgeSeconds}s (possible replay)`)
    return c.json({ status: 'ignored', reason: 'stale', eventsCount: 0 }, 200)
  }
  if (!webhookDeliveryIds.remember(deliveryId)) {
    return c.json({ status: 'ignored', reason: 'duplicate', eventsCount: 0 }, 200)
  }

  // Normalize incoming messages and statuses
  const normalizedEvents = normalizeMetaWebhook(payload)

  // Asynchronously dispatch to subscriber (e.g. Cautia backend)
  const subscriberUrl = getEnvVar(c, 'SUBSCRIBER_WEBHOOK_URL')
  const subscriberSecret = getEnvVar(c, 'SUBSCRIBER_WEBHOOK_SECRET')

  if (subscriberUrl && normalizedEvents.length > 0 && !subscriberSecret) {
    // Fail closed: subscribers must be able to verify that events came from this gateway
    console.error('[watahub] SUBSCRIBER_WEBHOOK_SECRET is not set; not forwarding unsigned events')
  } else if (subscriberUrl && subscriberSecret && normalizedEvents.length > 0) {
    const forwardPayload = {
      timestamp: Date.now(),
      events: normalizedEvents,
      raw: payload,
    }

    const forwardPromise = deliverToSubscriber({
      url: subscriberUrl,
      body: JSON.stringify(forwardPayload),
      secret: subscriberSecret,
      deliveryId,
    }).catch((err) => console.error('[watahub] Async dispatch error:', err instanceof Error ? err.name : 'unknown'))

    // Non-blocking execution. Hono's executionCtx getter throws outside Workers,
    // which used to turn every forwarded webhook on Node into a 500 (and a Meta retry).
    let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined
    try {
      executionCtx = c.executionCtx
    } catch {
      executionCtx = undefined
    }
    executionCtx?.waitUntil(forwardPromise)
  }

  // Meta expects an immediate 200 OK
  return c.json({
    status: 'received',
    eventsCount: normalizedEvents.length,
  }, 200)
})
