import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { healthRouter } from './routes/health.js'
import { webhookRouter } from './routes/webhook.js'
import { messagesRouter } from './routes/messages.js'
import { templatesRouter } from './routes/templates.js'
import { onboardingRouter } from './routes/onboarding.js'
import { proxyRouter } from './routes/proxy.js'

export const app = new Hono()

// Middlewares
app.use('*', logger())
app.use('*', cors())

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
  console.error('[watahub-error]', err)
  return c.json(
    {
      error: {
        message: err.message || 'Internal Server Error',
      },
    },
    500
  )
})

export default app
