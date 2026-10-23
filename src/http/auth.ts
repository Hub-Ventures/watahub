import type { Context, MiddlewareHandler } from 'hono'
import { getConfig } from '../config.js'
import type { Logger } from '../logger.js'
import { timingSafeEqual } from '../services/crypto.js'
import { isStrongApiKey } from '../utils/env.js'

/**
 * Gateway API key guard for every authenticated surface (/v1/*, /v24.0/*).
 *
 * Fails closed: if WATAHUB_API_KEY is not configured (or too weak) the gateway
 * refuses to serve these routes instead of exposing the Meta system user token
 * to anyone. Accepts either `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 */
export function requireApiKey(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const { apiKey } = getConfig(c)
    // Workers has no boot step, so the strength rules from validateEnv are enforced here too
    if (!apiKey || !isStrongApiKey(apiKey)) {
      logger.error('[watahub] WATAHUB_API_KEY is missing, too short or a placeholder; refusing authenticated route')
      return c.json({ error: 'Gateway misconfigured: WATAHUB_API_KEY is missing or too weak' }, 503)
    }

    if (!(await hasValidApiKey(c, apiKey))) {
      return c.json({ error: 'Unauthorized: Invalid Watahub API key' }, 401)
    }

    await next()
  }
}

/**
 * Drop-in Meta clients send `Authorization: Bearer <meta token>` next to X-API-Key,
 * so either header may carry the gateway key. Every candidate is compared in constant time.
 */
async function hasValidApiKey(c: Context, apiKey: string): Promise<boolean> {
  const authHeader = c.req.header('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined
  const candidates = [bearer, c.req.header('x-api-key')].filter((value): value is string => !!value)

  const matches = await Promise.all(candidates.map((candidate) => timingSafeEqual(candidate, apiKey)))
  return matches.includes(true)
}

/** Per-request Meta token: `X-Meta-Access-Token` header wins over META_SYSTEM_USER_TOKEN. */
export function resolveMetaAccessToken(c: Context): string | undefined {
  return c.req.header('x-meta-access-token') || getConfig(c).metaSystemUserToken
}
