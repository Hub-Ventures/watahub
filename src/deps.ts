import { systemClock, type Clock } from './clock.js'
import { consoleLogger, type Logger } from './logger.js'
import { MetaClient, type MetaClientConfig, type MetaGraphClient } from './services/meta-client.js'

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
}

export function createDefaultDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  // The global fetch is resolved on every call so runtime polyfills and test spies apply
  const fetchFn = overrides.fetch ?? ((input, init) => fetch(input, init))
  return {
    createMetaClient: (config) => new MetaClient({ fetch: fetchFn, ...config }),
    fetch: fetchFn,
    now: systemClock,
    logger: consoleLogger,
    ...overrides,
  }
}
