import type { ExecutionContext, Hono } from 'hono'
import { createApp } from './index.js'
import { consoleLogger } from './logger.js'
import { cloudflareKvStore, type KvNamespaceLike } from './services/cloudflare-kv.js'
import { DistributedLineStore } from './services/store-adapters.js'
import { isRecord } from './utils/guards.js'

/** A binding that is not a KV namespace (a plain var, for example) counts as missing. */
function isKvNamespace(value: unknown): value is KvNamespaceLike {
  return (
    isRecord(value) &&
    typeof value.get === 'function' &&
    typeof value.put === 'function' &&
    typeof value.delete === 'function'
  )
}

/**
 * Builds the gateway for one Workers isolate from its bindings. With a `WATAHUB_KV`
 * namespace, line tokens are stored in KV, so every isolate reads what `connect` wrote.
 * Without it the in-memory defaults stay, and `POST /v1/onboarding/connect` answers 503.
 */
export function createWorkerApp(env: Record<string, unknown>): Hono {
  const namespace = env.WATAHUB_KV
  if (isKvNamespace(namespace)) {
    return createApp({ lineStore: new DistributedLineStore(cloudflareKvStore(namespace)) })
  }
  consoleLogger.error(
    '[watahub] WATAHUB_KV is not bound to a KV namespace: line tokens would stay in one isolate, so POST /v1/onboarding/connect answers 503. See docs/DEPLOYMENT.md'
  )
  return createApp()
}

// One app per isolate: createApp keeps state of its own, and bindings do not change inside an isolate
let isolateApp: Hono | undefined

export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Response | Promise<Response> {
    isolateApp ??= createWorkerApp(env)
    return isolateApp.fetch(request, env, ctx)
  },
}
