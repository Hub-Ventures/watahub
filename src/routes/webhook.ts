import { Hono } from 'hono'
import { getEnvVar } from '../utils/env.js'
import { verifyMetaSignature, signSubscriberPayload } from '../services/crypto.js'
import { normalizeMetaWebhook } from '../services/normalizer.js'
import type { MetaWebhookPayload } from '../types/meta.js'

export const webhookRouter = new Hono()

/**
 * Meta Webhook Verification Handshake
 * GET /webhook
 */
webhookRouter.get('/webhook', (c) => {
  const query = c.req.query()
  const mode = query['hub.mode']
  const token = query['hub.verify_token']
  const challenge = query['hub.challenge']

  const expectedToken = getEnvVar(c, 'META_WEBHOOK_VERIFY_TOKEN')

  if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
    return c.text(challenge || '', 200)
  }

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

  // Verify HMAC-SHA256 signature if META_APP_SECRET is configured
  if (appSecret) {
    const isValid = await verifyMetaSignature(rawBody, signature, appSecret)
    if (!isValid) {
      return c.json({ error: 'Invalid HMAC signature' }, 401)
    }
  }

  let payload: MetaWebhookPayload
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  // Normalize incoming messages and statuses
  const normalizedEvents = normalizeMetaWebhook(payload)

  // Asynchronously dispatch to subscriber (e.g. Cautia backend)
  const subscriberUrl = getEnvVar(c, 'SUBSCRIBER_WEBHOOK_URL')
  const subscriberSecret = getEnvVar(c, 'SUBSCRIBER_WEBHOOK_SECRET')

  if (subscriberUrl && normalizedEvents.length > 0) {
    const forwardPayload = {
      timestamp: Date.now(),
      events: normalizedEvents,
      raw: payload,
    }

    const forwardPromise = (async () => {
      try {
        const bodyStr = JSON.stringify(forwardPayload)
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'Watahub-Gateway/0.1.0',
        }

        if (subscriberSecret) {
          const sig = await signSubscriberPayload(bodyStr, subscriberSecret)
          headers['x-watahub-signature'] = sig
        }

        const res = await fetch(subscriberUrl, {
          method: 'POST',
          headers,
          body: bodyStr,
        })

        if (!res.ok) {
          console.error(`[watahub] Subscriber webhook returned HTTP ${res.status}`)
        }
      } catch (err) {
        console.error('[watahub] Failed to forward webhook to subscriber:', err)
      }
    })()

    // Non-blocking execution for Cloudflare Workers / Node
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(forwardPromise)
    } else {
      forwardPromise.catch((err) => console.error('[watahub] Async dispatch error:', err))
    }
  }

  // Meta expects an immediate 200 OK
  return c.json({
    status: 'received',
    eventsCount: normalizedEvents.length,
  }, 200)
})
