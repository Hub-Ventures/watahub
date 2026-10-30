import type { Context, MiddlewareHandler } from 'hono'
import { getConfig } from '../config.js'
import type { RateLimitStore } from '../deps.js'
import { isRecord } from '../utils/guards.js'

/**
 * In-memory fixed-window counters keyed by client address.
 *
 * State lives in one process (Node) or one isolate (Workers), so on Workers
 * this is a best-effort brake: put Cloudflare rate limiting rules in front for
 * a global limit.
 */
export class FixedWindowLimiter implements RateLimitStore {
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
 * Limiter key for the client, from its address (see limiterKey):
 * 1. TRUSTED_CLIENT_IP_HEADER when the operator runs behind a proxy that sets it
 * 2. the TCP peer on Node (@hono/node-server exposes it as env.incoming)
 * 3. CF-Connecting-IP on Workers, which Cloudflare sets and clients cannot override
 */
export function clientAddress(c: Context): string {
  return limiterKey(rawClientAddress(c))
}

function rawClientAddress(c: Context): string {
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

/**
 * IPv6 clients usually hold a whole /64 and can rotate addresses inside it, so an
 * IPv6 address is keyed by its /64 prefix. IPv4-mapped IPv6 (::ffff:1.2.3.4) is keyed
 * as the IPv4 address. IPv4 and anything that is not a valid IPv6 address are used as is.
 */
export function limiterKey(address: string): string {
  if (!address.includes(':')) return address
  // A zone index (fe80::1%eth0) names the local interface, not the client
  const groups = parseIpv6(address.replace(/%.*$/, ''))
  if (!groups) return address

  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (isIpv4Mapped) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

/** The eight 16-bit groups of an IPv6 address, expanding :: and a trailing IPv4, or undefined */
function parseIpv6(address: string): number[] | undefined {
  let text = address.toLowerCase()
  let embeddedIpv4: [number, number] | undefined
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (dotted) {
    const octets = dotted.slice(2).map(Number)
    if (octets.some((octet) => octet > 255)) return undefined
    embeddedIpv4 = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]]
    text = `${dotted[1]}0:0`
  }

  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const split = (part: string) => (part === '' ? [] : part.split(':'))
  const head = split(halves[0])
  const tail = halves.length === 2 ? split(halves[1]) : []
  const missing = 8 - head.length - tail.length
  // Without :: there must be exactly 8 groups; :: stands for at least one zero group
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  const values = groups.map((group) => parseInt(group, 16))
  if (embeddedIpv4) [values[6], values[7]] = embeddedIpv4
  return values
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
export function createRateLimitMiddleware(limiterFactory?: (limit: number) => RateLimitStore): MiddlewareHandler {
  return async (c, next) => {
    const limit = Number(getConfig(c).rateLimitPerMinute)
    if (!Number.isInteger(limit) || limit <= 0) return next()

    let limiter: RateLimitStore
    if (limiterFactory) {
      limiter = limiterFactory(limit)
    } else {
      let existing = requestLimiters.get(limit)
      if (!existing) {
        existing = new FixedWindowLimiter(limit, 60_000)
        requestLimiters.set(limit, existing)
      }
      limiter = existing
    }

    const key = clientAddress(c)
    const retryAfter = await limiter.blockedFor(key)
    if (retryAfter > 0) return tooManyRequests(c, retryAfter)
    await limiter.hit(key)
    await next()
  }
}

export function resetRateLimits(): void {
  apiKeyFailures.clear()
  verifyTokenFailures.clear()
  requestLimiters.clear()
}
