import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

const MB = 1024 * 1024

/** Request body size limits, checked against Content-Length and enforced while streaming */
export const BODY_LIMITS = {
  // Meta batches up to ~1000 updates per delivery; real payloads stay far below this
  webhook: 3 * MB,
  json: 1 * MB,
  // WhatsApp's largest media type (documents) is capped at 100 MB
  media: 100 * MB,
} as const

const tooLarge = (c: Context) => c.json({ error: 'Payload too large' }, 413)

const limit = (maxSize: number): MiddlewareHandler => bodyLimit({ maxSize, onError: tooLarge })

export const webhookBodyLimit = limit(BODY_LIMITS.webhook)
export const jsonBodyLimit = limit(BODY_LIMITS.json)
const mediaBodyLimit = limit(BODY_LIMITS.media)

/** Media uploads through the proxy get the media limit; every other proxied call is JSON */
export const proxyBodyLimit: MiddlewareHandler = (c, next) =>
  c.req.path.endsWith('/media') ? mediaBodyLimit(c, next) : jsonBodyLimit(c, next)
