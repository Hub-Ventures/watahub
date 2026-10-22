import { serve } from '@hono/node-server'
import app from './index.js'

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
