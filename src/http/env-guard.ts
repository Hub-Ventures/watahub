import type { Context, MiddlewareHandler } from 'hono'
import type { Logger } from '../logger.js'
import { invalidEnvVars, type FormattedEnvVar } from '../utils/env.js'

/** 503 that names the invalid variables, never their values */
export function misconfiguredResponse(c: Context, logger: Logger, invalid: readonly FormattedEnvVar[]): Response {
  const names = invalid.join(', ')
  logger.error(`[watahub] Invalid configuration (${names}); answering 503`)
  return c.json({ error: `Gateway misconfigured: invalid ${names}` }, 503)
}

/** Answers 503 while any of `keys` holds a value the boot-time validation would reject */
export function requireValidEnv(keys: readonly FormattedEnvVar[], logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const invalid = invalidEnvVars(c, keys)
    if (invalid.length > 0) return misconfiguredResponse(c, logger, invalid)
    await next()
  }
}
