import { systemClock, type Clock } from './clock.js'
import { apiKeyFailures, verifyTokenFailures } from './http/rate-limit.js'
import { consoleLogger, type Logger } from './logger.js'
import { MetaClient, type MetaClientConfig, type MetaGraphClient } from './services/meta-client.js'
import { webhookDeliveryIds } from './services/replay.js'

export interface ReplayStore {
  has(id: string, nowMs?: number): boolean | Promise<boolean>
  /**
   * Records a delivered ID. `ttlSeconds` is how long it must be kept so a replay
   * inside the webhook age window is still caught; keep it at least that long.
   */
  remember(id: string, nowMs?: number, ttlSeconds?: number): boolean | Promise<boolean>
  clear(): void | Promise<void>
}

export interface RateLimitStore {
  blockedFor(key: string, nowMs?: number): number | Promise<number>
  hit(key: string, nowMs?: number): void | Promise<void>
  clear(): void | Promise<void>
}

/**
 * Collaborators the HTTP layer depends on. Pass overrides to `createApp` to
 * swap implementations (tests, custom transports, structured logging) without
 * touching routes.
 */
export interface GatewayDeps {
  /** Builds the Meta Graph client for one request */
  createMetaClient: (config: MetaClientConfig) => MetaGraphClient
  /** Outbound HTTP for the Graph proxy and subscriber delivery */
  fetch: typeof fetch
  now: Clock
  logger: Logger
  /** Webhook replay protection store */
  replayStore: ReplayStore
  /** Rate limiter for failed API keys */
  apiKeyLimiter: RateLimitStore
  /** Rate limiter for failed webhook verify tokens */
  verifyTokenLimiter: RateLimitStore
  /** Optional factory for per-client request rate limiters */
  createRequestLimiter?: (limit: number) => RateLimitStore
}

export function createDefaultDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  // The global fetch is resolved on every call so runtime polyfills and test spies apply
  const fetchFn = overrides.fetch ?? ((input, init) => fetch(input, init))
  return {
    createMetaClient: (config) => new MetaClient({ fetch: fetchFn, ...config }),
    fetch: fetchFn,
    now: systemClock,
    logger: consoleLogger,
    replayStore: overrides.replayStore ?? webhookDeliveryIds,
    apiKeyLimiter: overrides.apiKeyLimiter ?? apiKeyFailures,
    verifyTokenLimiter: overrides.verifyTokenLimiter ?? verifyTokenFailures,
    ...overrides,
  }
}
