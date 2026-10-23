import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { getEnvVar } from '../utils/env.js'

/**
 * Parses CORS_ALLOWED_ORIGINS (comma-separated exact origins such as
 * https://app.example.com). Wildcards are not supported: the gateway API key
 * must never live in browser code served from arbitrary sites.
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => {
      try {
        return origin !== '' && new URL(origin).origin === origin
      } catch {
        return false
      }
    })
}

/**
 * CORS is off unless CORS_ALLOWED_ORIGINS lists origins. Watahub is a
 * server-to-server gateway, so by default browsers get no CORS headers.
 */
export const corsFromEnv: MiddlewareHandler = (c, next) => {
  const origins = parseAllowedOrigins(getEnvVar(c, 'CORS_ALLOWED_ORIGINS'))
  if (origins.length === 0) return next()
  return cors({
    origin: origins,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-API-Key', 'X-Phone-Number-Id', 'X-Meta-Access-Token'],
    maxAge: 600,
  })(c, next)
}
