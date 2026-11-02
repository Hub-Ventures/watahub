import type { LineStore, RateLimitStore, ReplayStore, StoredLine } from '../deps.js'
import { isRecord } from '../utils/guards.js'
import { DEFAULT_REPLAY_TTL_SECONDS } from './replay.js'

/**
 * Minimal Key-Value Store interface compatible with Cloudflare KV, Redis, etc.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>
  delete?(key: string): Promise<void>
}

/**
 * ReplayStore adapter backed by a KeyValueStore (Cloudflare KV, Redis, etc.)
 */
export class DistributedReplayStore implements ReplayStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly ttlSeconds = DEFAULT_REPLAY_TTL_SECONDS,
    private readonly prefix = 'watahub:delivery:'
  ) {}

  async has(id: string): Promise<boolean> {
    const value = await this.kv.get(`${this.prefix}${id}`)
    return value !== null
  }

  async remember(id: string, _nowMs?: number, ttlSeconds = 0): Promise<boolean> {
    const key = `${this.prefix}${id}`
    const existing = await this.kv.get(key)
    if (existing !== null) return false
    await this.kv.set(key, '1', { ttlSeconds: Math.max(this.ttlSeconds, ttlSeconds) })
    return true
  }

  async clear(): Promise<void> {
    // Distributed TTL-based expiry handles cleanup
  }
}

/**
 * RateLimitStore adapter backed by a KeyValueStore (Cloudflare KV, Redis, etc.)
 */
export class DistributedRateLimitStore implements RateLimitStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly limit: number,
    private readonly windowSeconds = 60,
    private readonly prefix = 'watahub:ratelimit:'
  ) {}

  async blockedFor(key: string, nowMs = Date.now()): Promise<number> {
    const raw = await this.kv.get(`${this.prefix}${key}`)
    if (!raw) return 0
    try {
      const data = JSON.parse(raw) as { count: number; resetAt: number }
      if (data.resetAt <= nowMs || data.count < this.limit) return 0
      return Math.ceil((data.resetAt - nowMs) / 1000)
    } catch {
      return 0
    }
  }

  async hit(key: string, nowMs = Date.now()): Promise<void> {
    const storageKey = `${this.prefix}${key}`
    const raw = await this.kv.get(storageKey)
    let count = 1
    let resetAt = nowMs + this.windowSeconds * 1000

    if (raw) {
      try {
        const data = JSON.parse(raw) as { count: number; resetAt: number }
        if (data.resetAt > nowMs) {
          count = data.count + 1
          resetAt = data.resetAt
        }
      } catch {
        // malformed value resets window
      }
    }

    const ttlSeconds = Math.max(1, Math.ceil((resetAt - nowMs) / 1000))
    await this.kv.set(storageKey, JSON.stringify({ count, resetAt }), { ttlSeconds })
  }

  async clear(): Promise<void> {
    // Distributed TTL-based expiry handles cleanup
  }
}

/**
 * LineStore adapter. No TTL: a business token stays until the line is connected again.
 * The value is the token, so callers must not log the raw KV payload.
 */
export class DistributedLineStore implements LineStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly prefix = 'watahub:line:'
  ) {}

  async get(phoneNumberId: string): Promise<StoredLine | undefined> {
    const raw = await this.kv.get(`${this.prefix}${phoneNumberId}`)
    if (!raw) return undefined
    return parseStoredLine(raw, phoneNumberId)
  }

  async put(line: StoredLine): Promise<void> {
    const stored: StoredLine = {
      phoneNumberId: line.phoneNumberId,
      wabaId: line.wabaId,
      accessToken: line.accessToken,
    }
    await this.kv.set(`${this.prefix}${line.phoneNumberId}`, JSON.stringify(stored))
  }
}

/** Untrusted KV bytes. A bad value is a miss so the caller falls through to the env token. */
function parseStoredLine(raw: string, phoneNumberId: string): StoredLine | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed.phoneNumberId !== phoneNumberId) return undefined
  if (typeof parsed.wabaId !== 'string' || parsed.wabaId.length === 0) return undefined
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return undefined
  return { phoneNumberId, wabaId: parsed.wabaId, accessToken: parsed.accessToken }
}
