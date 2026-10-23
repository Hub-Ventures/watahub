import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger as requestLogger } from 'hono/logger'
import { createDefaultDeps, type GatewayDeps } from './deps.js'
import { requireApiKey } from './http/auth.js'
import { jsonBodyLimit, proxyBodyLimit, webhookBodyLimit } from './http/limits.js'
import { createHealthRouter } from './routes/health.js'
import { createMessagesRouter } from './routes/messages.js'
import { createOnboardingRouter } from './routes/onboarding.js'
import { createProxyRouter } from './routes/proxy.js'
import { createTemplatesRouter } from './routes/templates.js'
import { createWebhookRouter } from './routes/webhook.js'
import { redactSecrets } from './utils/redact.js'

export type { GatewayDeps } from './deps.js'
export { BODY_LIMITS } from './http/limits.js'

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
  app.use('*', cors())

  // Every machine-to-machine surface requires the gateway API key (fail closed)
  const apiKeyGuard = requireApiKey(deps.logger)
  app.use('/v1/*', apiKeyGuard)
  app.use('/v24.0/*', apiKeyGuard)

  app.use('/webhook', webhookBodyLimit)
  app.use('/v1/*', jsonBodyLimit)
  app.use('/v24.0/*', proxyBodyLimit)

  app.route('/', createHealthRouter(deps.now))
  app.route('/', createWebhookRouter(deps))
  app.route('/', createMessagesRouter(deps))
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
