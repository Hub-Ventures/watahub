import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { HTTPException } from 'hono/http-exception'
import { healthRouter } from './routes/health.js'
import { webhookRouter } from './routes/webhook.js'
import { messagesRouter } from './routes/messages.js'
import { templatesRouter } from './routes/templates.js'
import { onboardingRouter } from './routes/onboarding.js'
import { proxyRouter } from './routes/proxy.js'
import { requireApiKey } from './middleware/auth.js'
import { corsFromEnv } from './middleware/cors.js'
import { rateLimitFromEnv } from './middleware/rate-limit.js'
import { redactSecrets } from './utils/redact.js'

export const app = new Hono()

// Middlewares
// Request lines include the query string (e.g. hub.verify_token), so redact before printing
app.use('*', logger((line, ...rest) => console.log(redactSecrets(line), ...rest)))
// JSON-only API: nothing may be framed, sniffed or loaded as a subresource
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    xFrameOptions: 'DENY',
  })
)
// Off by default; CORS_ALLOWED_ORIGINS opts specific origins in (src/middleware/cors.ts)
app.use('*', corsFromEnv)

// Optional per-client limit (RATE_LIMIT_PER_MINUTE), counted before auth so floods are cheap to refuse
app.use('/v1/*', rateLimitFromEnv)
app.use('/v24.0/*', rateLimitFromEnv)

// Every machine-to-machine surface requires the gateway API key (fail closed)
app.use('/v1/*', requireApiKey)
app.use('/v24.0/*', requireApiKey)

// Authenticated responses can carry access tokens (onboarding exchange) and Meta data
const noStore: MiddlewareHandler = async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'no-store')
}
app.use('/v1/*', noStore)
app.use('/v24.0/*', noStore)

// Request body size limits (checked against Content-Length and enforced while streaming)
const MB = 1024 * 1024
const tooLarge = (c: Context) => c.json({ error: 'Payload too large' }, 413)
export const BODY_LIMITS = {
  // Meta batches up to ~1000 updates per delivery; real payloads stay far below this
  webhook: 3 * MB,
  json: 1 * MB,
  // WhatsApp's largest media type (documents) is capped at 100 MB
  media: 100 * MB,
}
const jsonLimit = bodyLimit({ maxSize: BODY_LIMITS.json, onError: tooLarge })
const mediaLimit = bodyLimit({ maxSize: BODY_LIMITS.media, onError: tooLarge })

app.use('/webhook', bodyLimit({ maxSize: BODY_LIMITS.webhook, onError: tooLarge }))
app.use('/v1/*', jsonLimit)
app.use('/v24.0/*', (c, next) => (c.req.path.endsWith('/media') ? mediaLimit(c, next) : jsonLimit(c, next)))

// Mount sub-routers
app.route('/', healthRouter)
app.route('/', webhookRouter)
app.route('/', messagesRouter)
app.route('/', templatesRouter)
app.route('/', onboardingRouter)
app.route('/', proxyRouter)

// Fallback 404 handler
app.notFound((c) => {
  return c.json({ error: 'Endpoint not found', path: c.req.path }, 404)
})

// Global error handler
app.onError((err, c) => {
  // Hono's HTTPException (e.g. body limit) carries an intentional status and response
  if (err instanceof HTTPException) {
    return err.getResponse()
  }

  console.error('[watahub-error]', redactSecrets(err.stack || String(err)))
  // Internal error details stay in the logs; callers only get a generic message
  return c.json({ error: { message: 'Internal Server Error' } }, 500)
})

export default app
