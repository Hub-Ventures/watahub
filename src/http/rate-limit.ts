import type { Context, MiddlewareHandler } from 'hono'
import { getConfig } from '../config.js'
import { isRecord } from '../utils/guards.js'

/**
 * In-memory fixed-window counters keyed by client address.
 *
 * State lives in one process (Node) or one isolate (Workers), so on Workers
 * this is a best-effort brake: put Cloudflare rate limiting rules in front for
 * a global limit.
 */
export class FixedWindowLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  /** Seconds until the key may try again, or 0 when it is under the limit */
  blockedFor(key: string, nowMs = Date.now()): number {
    const window = this.windows.get(key)
    if (!window || window.resetAt <= nowMs || window.count < this.limit) return 0
    return Math.ceil((window.resetAt - nowMs) / 1000)
  }

  hit(key: string, nowMs = Date.now()): void {
    const window = this.windows.get(key)
    if (window && window.resetAt > nowMs) {
      window.count++
      return
    }
    if (this.windows.size >= this.maxKeys) this.evict(nowMs)
    this.windows.set(key, { count: 1, resetAt: nowMs + this.windowMs })
  }

  clear(): void {
    this.windows.clear()
  }

  private evict(nowMs: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= nowMs) this.windows.delete(key)
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break
      this.windows.delete(key)
    }
  }
}

/**
 * Client address used as the limiter key:
 * 1. TRUSTED_CLIENT_IP_HEADER when the operator runs behind a proxy that sets it
 * 2. the TCP peer on Node (@hono/node-server exposes it as env.incoming)
 * 3. CF-Connecting-IP on Workers, which Cloudflare sets and clients cannot override
 */
export function clientAddress(c: Context): string {
  const trustedHeader = getConfig(c).trustedClientIpHeader
  if (trustedHeader) {
    // Proxies append to X-Forwarded-For, so only the last entry was written by the
    // trusted proxy; the leftmost ones are whatever the client sent
    const entries = c.req.header(trustedHeader)?.split(',') ?? []
    return entries[entries.length - 1]?.trim() || 'unknown'
  }
  const bindings: unknown = c.env
  if (isRecord(bindings) && isRecord(bindings.incoming)) {
    const socket = bindings.incoming.socket
    const remoteAddress = isRecord(socket) ? socket.remoteAddress : undefined
    return typeof remoteAddress === 'string' && remoteAddress ? remoteAddress : 'unknown'
  }
  return c.req.header('cf-connecting-ip') || 'unknown'
}

/** Failed API key or verify token attempts allowed per client per minute (separate counters) */
export const AUTH_FAILURE_LIMIT = 10
export const apiKeyFailures = new FixedWindowLimiter(AUTH_FAILURE_LIMIT, 60_000)
export const verifyTokenFailures = new FixedWindowLimiter(AUTH_FAILURE_LIMIT, 60_000)

export function tooManyRequests(c: Context, retryAfterSeconds: number) {
  c.header('Retry-After', String(retryAfterSeconds))
  return c.json({ error: 'Too many requests' }, 429)
}

const requestLimiters = new Map<number, FixedWindowLimiter>()

/**
 * Optional per-client request limit for /v1 and /v24.0, enabled by
 * RATE_LIMIT_PER_MINUTE. Meta enforces its own throughput limits; this one
 * protects the gateway and its token from a single noisy or leaked client.
 */
export const rateLimitFromEnv: MiddlewareHandler = async (c, next) => {
  const limit = Number(getConfig(c).rateLimitPerMinute)
  if (!Number.isInteger(limit) || limit <= 0) return next()

  let limiter = requestLimiters.get(limit)
  if (!limiter) {
    limiter = new FixedWindowLimiter(limit, 60_000)
    requestLimiters.set(limit, limiter)
  }

  const key = clientAddress(c)
  const retryAfter = limiter.blockedFor(key)
  if (retryAfter > 0) return tooManyRequests(c, retryAfter)
  limiter.hit(key)
  await next()
}

export function resetRateLimits(): void {
  apiKeyFailures.clear()
  verifyTokenFailures.clear()
  requestLimiters.clear()
}
