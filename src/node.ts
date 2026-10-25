import { serve } from '@hono/node-server'
import { drainBackgroundTasks } from './http/background.js'
import app from './index.js'
import { validateEnv } from './utils/env.js'

// Refuse to boot with an insecure or incomplete configuration
const envCheck = validateEnv(process.env)
if (!envCheck.ok) {
  console.error('[watahub] Invalid configuration, refusing to start:')
  for (const error of envCheck.errors) console.error(`  - ${error}`)
  process.exit(1)
}

const port = Number(process.env.PORT) || 3000

console.log(`
┌───────────────────────────────────────────────┐
│              🌊  WATAHUB GATEWAY  🌊           │
│        Open-Source WhatsApp Cloud API IaaS    │
├───────────────────────────────────────────────┤
│  Status:   Running on Node.js                 │
│  Port:     ${port}                               │
│  Health:   http://localhost:${port}/health       │
│  Webhook:  http://localhost:${port}/webhook      │
│  Messages: http://localhost:${port}/v1/messages  │
└───────────────────────────────────────────────┘
`)

const server = serve({
  fetch: app.fetch,
  port,
})

const handleShutdown = (signal: string) => {
  console.log(`[watahub] Received ${signal}, starting graceful shutdown...`)
  server.close(() => {
    console.log('[watahub] Server closed to new connections, draining background tasks...')
    void drainBackgroundTasks(15_000).then(() => {
      console.log('[watahub] Graceful shutdown complete.')
      process.exit(0)
    })
  })
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'))
process.on('SIGINT', () => handleShutdown('SIGINT'))
