import type { MiddlewareHandler } from 'hono'
import { getEnvVar, isStrongApiKey } from '../utils/env.js'
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
  // Workers has no boot step, so the strength rules from validateEnv are enforced here too
  if (!apiKey || !isStrongApiKey(apiKey)) {
    console.error('[watahub] WATAHUB_API_KEY is missing, too short or a placeholder; refusing authenticated route')
    return c.json({ error: 'Gateway misconfigured: WATAHUB_API_KEY is missing or too weak' }, 503)
  }

  // Drop-in Meta clients send `Authorization: Bearer <meta token>` next to X-API-Key,
  // so either header may carry the gateway key. Both are always compared.
  const authHeader = c.req.header('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  const candidates = [bearer, c.req.header('x-api-key')].filter((value): value is string => !!value)

  const matches = await Promise.all(candidates.map((candidate) => timingSafeEqual(candidate, apiKey)))
  if (!matches.includes(true)) {
    return c.json({ error: 'Unauthorized: Invalid Watahub API key' }, 401)
  }

  await next()
}
