import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { healthRouter } from './routes/health.js'
import { webhookRouter } from './routes/webhook.js'
import { messagesRouter } from './routes/messages.js'
import { templatesRouter } from './routes/templates.js'
import { onboardingRouter } from './routes/onboarding.js'
import { proxyRouter } from './routes/proxy.js'
import { requireApiKey } from './middleware/auth.js'
import { redactSecrets } from './utils/redact.js'

export const app = new Hono()

// Middlewares
// Request lines include the query string (e.g. hub.verify_token), so redact before printing
app.use('*', logger((line, ...rest) => console.log(redactSecrets(line), ...rest)))
app.use('*', cors())

// Every machine-to-machine surface requires the gateway API key (fail closed)
app.use('/v1/*', requireApiKey)
app.use('/v24.0/*', requireApiKey)

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
