import type { MiddlewareHandler } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

/** JSON-only API: nothing may be framed, sniffed or loaded as a subresource */
export const securityHeaders: MiddlewareHandler = secureHeaders({
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  xFrameOptions: 'DENY',
})

/**
 * Authenticated responses can carry access tokens (onboarding exchange) and Meta data.
 * Register it before auth so 401/429/503 answers from these surfaces are covered too.
 */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'no-store')
}
