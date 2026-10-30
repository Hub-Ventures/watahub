import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger as requestLogger } from 'hono/logger'
import { createDefaultDeps, type GatewayDeps } from './deps.js'
import { requireApiKey } from './http/auth.js'
import { corsFromEnv } from './http/cors.js'
import { requireValidEnv } from './http/env-guard.js'
import { noStore, securityHeaders } from './http/headers.js'
import { proxyBodyLimit, v1BodyLimit, webhookBodyLimit } from './http/limits.js'
import { createRateLimitMiddleware } from './http/rate-limit.js'
import { createHealthRouter } from './routes/health.js'
import { createMediaRouter } from './routes/media.js'
import { createMessagesRouter } from './routes/messages.js'
import { createOnboardingRouter } from './routes/onboarding.js'
import { createProxyRouter } from './routes/proxy.js'
import { createTemplatesRouter } from './routes/templates.js'
import { createWebhookRouter } from './routes/webhook.js'
import { redactSecrets } from './utils/redact.js'

export type { GatewayDeps, RateLimitStore, ReplayStore } from './deps.js'
export { createDefaultDeps } from './deps.js'
export { BODY_LIMITS } from './http/limits.js'
export { requireApiKey, resolveMetaAccessToken } from './http/auth.js'
export { DistributedRateLimitStore, DistributedReplayStore, type KeyValueStore } from './services/store-adapters.js'
export { verifyMetaSignature, signSubscriberPayload, timingSafeEqual, sha256Hex } from './services/crypto.js'
export {
  deliverToSubscriber,
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  type DeliveryRequest,
  type DeliveryResult,
} from './services/delivery.js'
export { normalizeMetaWebhook, extractPhoneNumberId, hasWebhookChanges } from './services/normalizer.js'
export { MetaClient, type MetaClientConfig, type MetaGraphClient } from './services/meta-client.js'
export * from './types/gateway.js'
export * from './types/meta.js'
export { redactSecrets } from './utils/redact.js'

/**
 * Builds the gateway app. Override `deps` to inject collaborators
 * (a fake Meta client, a fetch stub, a fixed clock, a structured logger).
 */
export function createApp(overrides: Partial<GatewayDeps> = {}): Hono {
  const deps = createDefaultDeps(overrides)
  const app = new Hono()

  // Request lines include the query string (e.g. hub.verify_token), so redact before printing
  app.use(
    '*',
    requestLogger((...parts) => deps.logger.info(redactSecrets(parts.join(' '))))
  )
  app.use('*', securityHeaders)
  // Workers have no boot-time validation (src/node.ts), so each surface checks the
  // optional variables it reads and answers 503 instead of silently falling back
  app.use('*', requireValidEnv(['CORS_ALLOWED_ORIGINS'], deps.logger))
  // Off by default; CORS_ALLOWED_ORIGINS opts specific origins in (src/http/cors.ts)
  app.use('*', corsFromEnv)

  const apiKeyGuard = requireApiKey(deps.logger, deps.apiKeyLimiter)
  const rateLimitGuard = createRateLimitMiddleware(deps.createRequestLimiter)
  const surfaceEnv = {
    '/v1/*': requireValidEnv(['RATE_LIMIT_PER_MINUTE', 'TRUSTED_CLIENT_IP_HEADER', 'META_API_VERSION'], deps.logger),
    '/v24.0/*': requireValidEnv(['RATE_LIMIT_PER_MINUTE', 'TRUSTED_CLIENT_IP_HEADER'], deps.logger),
  }
  for (const surface of ['/v1/*', '/v24.0/*'] as const) {
    // Order matters: no-store wraps every answer, every machine-to-machine surface
    // requires the gateway API key (fail closed), and only authenticated requests
    // count against RATE_LIMIT_PER_MINUTE, so callers without the key cannot spend
    // a legitimate client's quota (failed keys have their own limiter in requireApiKey)
    app.use(surface, noStore)
    app.use(surface, surfaceEnv[surface])
    app.use(surface, apiKeyGuard)
    app.use(surface, rateLimitGuard)
  }

  app.use('/webhook', webhookBodyLimit)
  app.use('/v1/*', v1BodyLimit)
  app.use('/v24.0/*', proxyBodyLimit)

  app.route('/', createHealthRouter(deps.now))
  app.route('/', createWebhookRouter(deps))
  app.route('/', createMessagesRouter(deps))
  app.route('/', createMediaRouter(deps))
  app.route('/', createTemplatesRouter(deps))
  app.route('/', createOnboardingRouter(deps))
  app.route('/', createProxyRouter(deps))

  app.notFound((c) => c.json({ error: 'Endpoint not found', path: c.req.path }, 404))

  app.onError((err, c) => {
    // Hono's HTTPException (e.g. body limit) carries an intentional status and response
    if (err instanceof HTTPException) return err.getResponse()

    // Internal error details stay in the logs; callers only get a generic message
    deps.logger.error(`[watahub-error] ${redactSecrets(err.stack || String(err))}`)
    return c.json({ error: { message: 'Internal Server Error' } }, 500)
  })

  return app
}

export const app = createApp()

export default app
