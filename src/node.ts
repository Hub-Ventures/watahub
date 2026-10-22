import { serve } from '@hono/node-server'
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

serve({
  fetch: app.fetch,
  port,
})
