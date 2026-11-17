import type { KeyValueStore } from './store-adapters.js'

/** Cloudflare KV rejects an `expirationTtl` below 60 seconds. */
const MIN_KV_EXPIRATION_TTL_SECONDS = 60

/**
 * The three `KVNamespace` methods the gateway uses. A structural type, so the core
 * does not depend on `@cloudflare/workers-types`: a real KV binding satisfies it.
 */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * `KeyValueStore` over a Cloudflare KV namespace. `set` becomes `put`; a TTL is raised
 * to at least 60 seconds, and no TTL means the key does not expire.
 */
export function cloudflareKvStore(namespace: KvNamespaceLike): KeyValueStore {
  return {
    get: (key) => namespace.get(key),
    set: (key, value, options) => {
      const ttlSeconds = options?.ttlSeconds
      if (ttlSeconds === undefined) return namespace.put(key, value)
      return namespace.put(key, value, {
        expirationTtl: Math.max(MIN_KV_EXPIRATION_TTL_SECONDS, Math.ceil(ttlSeconds)),
      })
    },
    delete: (key) => namespace.delete(key),
  }
}
