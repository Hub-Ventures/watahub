import type { PhoneConfig, PhoneDirectory, RateLimitStore, ReplayStore } from '../deps.js'

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
    private readonly ttlSeconds = 24 * 60 * 60,
    private readonly prefix = 'watahub:delivery:'
  ) {}

  async has(id: string): Promise<boolean> {
    const value = await this.kv.get(`${this.prefix}${id}`)
    return value !== null
  }

  async remember(id: string): Promise<boolean> {
    const key = `${this.prefix}${id}`
    const existing = await this.kv.get(key)
    if (existing !== null) return false
    await this.kv.set(key, '1', { ttlSeconds: this.ttlSeconds })
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
 * PhoneDirectory adapter backed by a KeyValueStore (Cloudflare KV, Redis, etc.)
 */
export class DistributedPhoneDirectory implements PhoneDirectory {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly prefix = 'watahub:phone:'
  ) {}

  async lookup(phoneNumberId: string): Promise<PhoneConfig | null> {
    const raw = await this.kv.get(`${this.prefix}${phoneNumberId}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as PhoneConfig
    } catch {
      return null
    }
  }

  async set(phoneNumberId: string, config: PhoneConfig): Promise<void> {
    await this.kv.set(`${this.prefix}${phoneNumberId}`, JSON.stringify(config))
  }

  async delete(phoneNumberId: string): Promise<void> {
    if (this.kv.delete) {
      await this.kv.delete(`${this.prefix}${phoneNumberId}`)
    }
  }
}
