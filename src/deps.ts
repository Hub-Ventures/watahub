import { systemClock, type Clock } from './clock.js'
import { apiKeyFailures, verifyTokenFailures } from './http/rate-limit.js'
import { consoleLogger, type Logger } from './logger.js'
import { MetaClient, type MetaClientConfig, type MetaGraphClient } from './services/meta-client.js'
import { webhookDeliveryIds } from './services/replay.js'

/**
 * Business token for one phone line of this operator.
 * Stored server-side. Never copied into an API response or a log line.
 */
export interface StoredLine {
  phoneNumberId: string
  wabaId: string
  accessToken: string
}

/**
 * Phone-line credentials for one operator (one Meta app, N numbers).
 * Sync for one process, async for KV. Not a tenant directory.
 */
export interface LineStore {
  get(phoneNumberId: string): Promise<StoredLine | undefined> | StoredLine | undefined
  put(line: StoredLine): Promise<void> | void
}

/**
 * In-process line store owned by `createApp`. Isolates do not share it;
 * `DistributedLineStore` is the KV adapter when tokens must outlive the process.
 */
export class MemoryLineStore implements LineStore {
  private readonly lines = new Map<string, StoredLine>()

  get(phoneNumberId: string): StoredLine | undefined {
    return this.lines.get(phoneNumberId)
  }

  put(line: StoredLine): void {
    this.lines.set(line.phoneNumberId, {
      phoneNumberId: line.phoneNumberId,
      wabaId: line.wabaId,
      accessToken: line.accessToken,
    })
  }
}

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
  /** Business tokens produced when a phone line connects */
  lineStore: LineStore
}

export function createDefaultDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  // A key passed as `undefined` asks for the default, so a conditional override cannot leave a port unset
  const given: Partial<GatewayDeps> = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  )
  // The global fetch is resolved on every call so runtime polyfills and test spies apply
  const fetchFn = given.fetch ?? ((input, init) => fetch(input, init))
  return {
    createMetaClient: (config) => new MetaClient({ fetch: fetchFn, ...config }),
    fetch: fetchFn,
    now: systemClock,
    logger: consoleLogger,
    replayStore: webhookDeliveryIds,
    apiKeyLimiter: apiKeyFailures,
    verifyTokenLimiter: verifyTokenFailures,
    lineStore: given.lineStore ?? new MemoryLineStore(),
    ...given,
  }
}
