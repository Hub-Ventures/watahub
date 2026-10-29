import type { RateLimitStore, ReplayStore } from '../deps.js'
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
