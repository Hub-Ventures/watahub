import type { MiddlewareHandler } from 'hono'
import { getEnvVar } from '../utils/env.js'
import { timingSafeEqual } from '../services/crypto.js'

/**
 * Gateway API key guard for every authenticated surface (/v1/*, /v24.0/*).
 *
 * Fails closed: if WATAHUB_API_KEY is not configured the gateway refuses to
 * serve these routes instead of exposing the Meta system user token to anyone.
 * Accepts either `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 */
export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const apiKey = getEnvVar(c, 'WATAHUB_API_KEY')
  if (!apiKey) {
    console.error('[watahub] WATAHUB_API_KEY is not set; refusing authenticated route')
    return c.json({ error: 'Gateway misconfigured: WATAHUB_API_KEY is not set' }, 503)
  }

  const authHeader = c.req.header('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  const provided = bearer ?? c.req.header('x-api-key')

  if (!provided || !(await timingSafeEqual(provided, apiKey))) {
    return c.json({ error: 'Unauthorized: Invalid Watahub API key' }, 401)
  }

  await next()
}
