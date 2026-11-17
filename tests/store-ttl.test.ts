import { describe, expect, it } from 'vitest'
import { DistributedRateLimitStore } from '../src/services/store-adapters.js'

/** A store that keeps the TTL of each write and, like Cloudflare KV, rejects one below 60 s. */
class FloorKv {
  readonly map = new Map<string, string>()
  readonly ttls: number[] = []
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null)
  }
  set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttl = options?.ttlSeconds
    if (ttl !== undefined && ttl < 60) return Promise.reject(new Error('expirationTtl below 60'))
    this.ttls.push(ttl ?? 0)
    this.map.set(key, value)
    return Promise.resolve()
  }
}

describe('DistributedRateLimitStore TTL floor', () => {
  it('asks for the whole window when it is longer than 60 s', async () => {
    const kv = new FloorKv()
    await new DistributedRateLimitStore(kv, 5, 300).hit('ip', 0)
    expect(kv.ttls).toEqual([300])
  })

  it('never asks for less than 60 s, one second before the window ends', async () => {
    const kv = new FloorKv()
    const store = new DistributedRateLimitStore(kv, 5, 60)
    await store.hit('ip', 0)
    await store.hit('ip', 59_000)
    expect(kv.ttls).toEqual([60, 60])
  })

  it('never asks for less than 60 s with a short window', async () => {
    const kv = new FloorKv()
    const store = new DistributedRateLimitStore(kv, 5, 10)
    await store.hit('ip', 0)
    await store.hit('ip', 9_999)
    expect(Math.min(...kv.ttls)).toBe(60)
  })

  it('still resets a 10 s window after 10 s although the key lives 60 s', async () => {
    const kv = new FloorKv()
    const store = new DistributedRateLimitStore(kv, 2, 10)
    await store.hit('ip', 0)
    await store.hit('ip', 1_000)
    expect(await store.blockedFor('ip', 1_000)).toBe(9)
    expect(await store.blockedFor('ip', 9_999)).toBe(1)
    expect(await store.blockedFor('ip', 10_000)).toBe(0)

    // The key is still there, but the next hit opens a new window.
    expect(kv.map.has('watahub:ratelimit:ip')).toBe(true)
    await store.hit('ip', 10_000)
    expect(JSON.parse(kv.map.get('watahub:ratelimit:ip') ?? '{}')).toEqual({ count: 1, resetAt: 20_000 })
    expect(await store.blockedFor('ip', 10_000)).toBe(0)
  })
})
