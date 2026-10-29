import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { runInBackground } from '../http/background.js'
import { clientAddress, tooManyRequests } from '../http/rate-limit.js'
import { errorName } from '../logger.js'
import { sha256Hex, timingSafeEqual, verifyMetaSignature } from '../services/crypto.js'
import { deliverToSubscriber, DEFAULT_DELIVERY_POLICY } from '../services/delivery.js'
import { hasWebhookChanges, normalizeMetaWebhook } from '../services/normalizer.js'
import { DEFAULT_WEBHOOK_MAX_AGE_SECONDS, isStale, replayTtlSeconds } from '../services/replay.js'
import type { SubscriberPayload } from '../types/gateway.js'
import type { MetaWebhookPayload } from '../types/meta.js'

export function createWebhookRouter(deps: GatewayDeps): Hono {
  const router = new Hono()

  /**
   * Meta Webhook Verification Handshake
   * GET /webhook
   */
  router.get('/webhook', async (c) => {
    const mode = c.req.query('hub.mode')
    const token = c.req.query('hub.verify_token')
    const challenge = c.req.query('hub.challenge')
    const expectedToken = getConfig(c).metaWebhookVerifyToken

    if (mode === 'subscribe' && token && expectedToken && (await timingSafeEqual(token, expectedToken))) {
      return c.text(challenge || '', 200)
    }

    // Throttle guessing on this public route; the correct token is never refused (see requireApiKey)
    const client = clientAddress(c)
    const retryAfter = await deps.verifyTokenLimiter.blockedFor(client)
    if (retryAfter > 0) return tooManyRequests(c, retryAfter)
    await deps.verifyTokenLimiter.hit(client)
    return c.text('Forbidden: Webhook verification failed', 403)
  })

  /**
   * Meta Webhook Ingestion & Subscriber Forwarding
   * POST /webhook
   */
  router.post('/webhook', async (c) => {
    const rawBody = await c.req.text()
    const config = getConfig(c)

    // Fail closed: without META_APP_SECRET there is no way to authenticate Meta,
    // so unsigned payloads must never be accepted or forwarded.
    if (!config.metaAppSecret) {
      deps.logger.error('[watahub] META_APP_SECRET is not set; rejecting webhook delivery')
      return c.json({ error: 'Gateway misconfigured: webhook signature secret is not set' }, 503)
    }

    const isValid = await verifyMetaSignature(rawBody, c.req.header('x-hub-signature-256'), config.metaAppSecret)
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
    const now = deps.now()
    const maxAgeSeconds = Number(config.metaWebhookMaxAgeSeconds) || DEFAULT_WEBHOOK_MAX_AGE_SECONDS
    // Remember for the whole window: a forgotten ID would let a still-fresh body through again
    const replayTtl = replayTtlSeconds(maxAgeSeconds)
    if (isStale(payload, maxAgeSeconds, now)) {
      deps.logger.error(
        `[watahub] Ignoring webhook ${deliveryId}: events older than ${maxAgeSeconds}s (possible replay)`
      )
      return c.json({ status: 'ignored', reason: 'stale', eventsCount: 0 }, 200)
    }
    if (await deps.replayStore.has(deliveryId, now)) {
      return c.json({ status: 'ignored', reason: 'duplicate', eventsCount: 0 }, 200)
    }

    const events = normalizeMetaWebhook(payload, deps.now)
    const hasChanges = hasWebhookChanges(payload)

    // Payloads with no changes (e.g. empty heartbeats) are acknowledged without forwarding
    if (events.length === 0 && !hasChanges) {
      await deps.replayStore.remember(deliveryId, now, replayTtl)
      return c.json({ status: 'received', eventsCount: 0 }, 200)
    }

    // Fail closed: if subscriber destination or secret are missing, respond 503 so Meta retries
    const url = config.subscriberWebhookUrl
    const secret = config.subscriberWebhookSecret

    if (!url) {
      deps.logger.error(
        `[watahub] SUBSCRIBER_WEBHOOK_URL is not set; rejecting delivery ${deliveryId} with 503 so Meta retries`
      )
      return c.json({ error: 'Gateway misconfigured: subscriber webhook URL is not set' }, 503)
    }
    if (!secret) {
      deps.logger.error(
        `[watahub] SUBSCRIBER_WEBHOOK_SECRET is not set; rejecting delivery ${deliveryId} with 503 so Meta retries`
      )
      return c.json({ error: 'Gateway misconfigured: subscriber signing secret is not set' }, 503)
    }

    const forward: SubscriberPayload = {
      timestamp: now,
      events,
      raw: payload,
    }

    const deliveryRequest = { url, body: JSON.stringify(forward), secret, deliveryId }
    const deliveryMode = config.webhookDeliveryMode || 'sync'

    if (deliveryMode === 'async') {
      const asyncDelivery = deliverToSubscriber(deliveryRequest, DEFAULT_DELIVERY_POLICY, {
        fetch: deps.fetch,
        logger: deps.logger,
      })
        .then(async (result) => {
          if (result.delivered) await deps.replayStore.remember(deliveryId, deps.now(), replayTtl)
        })
        .catch((err: unknown) => deps.logger.error(`[watahub] Async dispatch error: ${errorName(err)}`))

      runInBackground(c, asyncDelivery)
      return c.json({ status: 'received', eventsCount: events.length }, 200)
    }

    // Default: Guaranteed Synchronous Delivery
    const result = await deliverToSubscriber(deliveryRequest, DEFAULT_DELIVERY_POLICY, {
      fetch: deps.fetch,
      logger: deps.logger,
    })

    if (!result.delivered) {
      deps.logger.error(
        `[watahub] Delivery to subscriber failed for ${deliveryId} after ${result.attempts} attempts; responding 503 so Meta retries`
      )
      return c.json(
        {
          error: 'Subscriber delivery failed',
          deliveryId,
          attempts: result.attempts,
          subscriberStatus: result.status,
        },
        503
      )
    }

    // Only mark as seen once confirmed delivered to subscriber
    await deps.replayStore.remember(deliveryId, deps.now(), replayTtl)
    return c.json({ status: 'received', eventsCount: events.length }, 200)
  })

  return router
}
