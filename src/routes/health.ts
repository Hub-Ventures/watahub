import { Hono } from 'hono'
import { GATEWAY_NAME, GATEWAY_VERSION } from '../config.js'
import type { Clock } from '../clock.js'

export function createHealthRouter(now: Clock): Hono {
  const router = new Hono()

  router.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: GATEWAY_NAME,
      version: GATEWAY_VERSION,
      timestamp: new Date(now()).toISOString(),
    })
  )

  return router
}
