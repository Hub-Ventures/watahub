import { Hono } from 'hono'
import { getConfig } from '../config.js'
import type { GatewayDeps } from '../deps.js'
import { runInBackground } from '../http/background.js'
import { errorName } from '../logger.js'
import { sha256Hex, timingSafeEqual, verifyMetaSignature } from '../services/crypto.js'
import { deliverToSubscriber, DEFAULT_DELIVERY_POLICY } from '../services/delivery.js'
import { normalizeMetaWebhook } from '../services/normalizer.js'
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

    const events = normalizeMetaWebhook(payload, deps.now)
    const { subscriberWebhookUrl: url, subscriberWebhookSecret: secret } = config

    if (url && events.length > 0) {
      if (!secret) {
        // Fail closed: subscribers must be able to verify that events came from this gateway
        deps.logger.error('[watahub] SUBSCRIBER_WEBHOOK_SECRET is not set; not forwarding unsigned events')
      } else {
        const forward: SubscriberPayload = { timestamp: deps.now(), events, raw: payload }
        const delivery = (async () => {
          // Derived from Meta's signed raw body, so a Meta redelivery of the same
          // payload produces the same ID and the subscriber can drop the duplicate
          const deliveryId = await sha256Hex(rawBody)
          await deliverToSubscriber(
            { url, body: JSON.stringify(forward), secret, deliveryId },
            DEFAULT_DELIVERY_POLICY,
            {
              fetch: deps.fetch,
              logger: deps.logger,
            }
          )
        })().catch((err: unknown) => deps.logger.error(`[watahub] Async dispatch error: ${errorName(err)}`))

        // Meta gets its 200 now; the delivery finishes after the response
        runInBackground(c, delivery)
      }
    }

    // Meta expects an immediate 200 OK
    return c.json({ status: 'received', eventsCount: events.length }, 200)
  })

  return router
}
