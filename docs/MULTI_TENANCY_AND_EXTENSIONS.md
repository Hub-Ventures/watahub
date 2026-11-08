# Extensions and Enterprise Edition

How to use the core as a library, how to share its state across processes or Worker isolates, and how Watahub
Enterprise Edition builds on it.

## 1. The core as a library

```bash
pnpm add watahub
```

The package ships ESM with type declarations (`dist/index.js`, `dist/index.d.ts`). `createApp` returns a Hono app
whose `fetch` is a standard fetch handler.

```ts
import { serve } from '@hono/node-server'
import { createApp } from 'watahub'

const app = createApp({ logger: myStructuredLogger })
serve({ fetch: app.fetch, port: 3000 })
```

The configuration comes from `process.env` or the Worker bindings, exactly as in the stock gateway. The library has no
boot check: each route checks the variables it reads on every request and answers `503` while one is missing or
malformed.

### 1.1 What `createApp` accepts

Any field of `GatewayDeps` replaces the default:

| Field | Default | Replace it to |
| :--- | :--- | :--- |
| `createMetaClient` | `new MetaClient({ fetch, ...config })` | Use a different Graph transport, or a fake in tests |
| `fetch` | Global `fetch` | Route outbound calls through an allowlist or a proxy |
| `now` | `Date.now` | Freeze time in tests |
| `logger` | `console` | Send logs to a structured logger |
| `replayStore` | In-memory `DeliveryIdCache` | Share delivered webhook IDs across instances |
| `apiKeyLimiter`, `verifyTokenLimiter` | In-memory, 10 failures per minute | Share failed-attempt counters |
| `createRequestLimiter` | In-memory, per limit value | Share the `RATE_LIMIT_PER_MINUTE` budget |
| `lineStore` | `MemoryLineStore`, one per app | Keep `connect` tokens across restarts and instances |

### 1.2 Exports

| Group | Exports |
| :--- | :--- |
| App | `createApp`, `app` (default export), `createDefaultDeps`, `requireApiKey`, `resolveMetaAccessToken`, `BODY_LIMITS` |
| Meta | `MetaClient`, `MetaClientConfig`, `MetaGraphClient` |
| Webhooks | `verifyMetaSignature`, `normalizeMetaWebhook`, `extractPhoneNumberId`, `hasWebhookChanges`, `isStale`, `DEFAULT_WEBHOOK_MAX_AGE_SECONDS`, `DeliveryIdCache` |
| Delivery | `deliverToSubscriber`, `DEFAULT_DELIVERY_POLICY`, `signSubscriberPayload` and the `Delivery*` types |
| Stores | `MemoryLineStore`, `DistributedLineStore`, `DistributedReplayStore`, `DistributedRateLimitStore` and the `LineStore`, `ReplayStore`, `RateLimitStore`, `StoredLine`, `KeyValueStore` types |
| Utilities | `timingSafeEqual`, `sha256Hex`, `redactSecrets` |
| Types | Every type in `src/types/gateway.ts` (requests, normalized events, `SubscriberPayload`) and `src/types/meta.ts` (Meta's wire format) |

A webhook endpoint of your own can reuse the pieces:

```ts
import {
  DEFAULT_WEBHOOK_MAX_AGE_SECONDS,
  isStale,
  normalizeMetaWebhook,
  sha256Hex,
  verifyMetaSignature,
  type MetaWebhookPayload,
  type WatahubNormalizedEvent,
} from 'watahub'

// Your own durable queue
declare function enqueue(deliveryId: string, events: WatahubNormalizedEvent[]): Promise<void>

export async function handleMetaWebhook(request: Request, appSecret: string): Promise<Response> {
  const raw = await request.text()
  if (!(await verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'), appSecret))) {
    return new Response('Invalid signature', { status: 401 })
  }
  const payload = JSON.parse(raw) as MetaWebhookPayload
  if (isStale(payload, DEFAULT_WEBHOOK_MAX_AGE_SECONDS)) return new Response('Stale', { status: 200 })
  await enqueue(await sha256Hex(raw), normalizeMetaWebhook(payload))
  return new Response('OK', { status: 200 })
}
```

## 2. Shared state

The default stores live in memory. On Node that is per process; on Workers it is per isolate, and Cloudflare runs
many. The adapters in `src/services/store-adapters.ts` keep the same state in any store that implements this contract:

```ts
interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>
  delete?(key: string): Promise<void>
}
```

| Adapter | Key prefix | TTL | Notes |
| :--- | :--- | :--- | :--- |
| `DistributedReplayStore(kv, ttlSeconds?)` | `watahub:delivery:` | The longer of `ttlSeconds` (default 7 days plus 1 hour) and the webhook window plus 1 hour | The gateway always asks for at least the webhook window, so a shorter `ttlSeconds` has no effect |
| `DistributedRateLimitStore(kv, limit, windowSeconds = 60)` | `watahub:ratelimit:` | Until the window ends | Read, then write: concurrent requests can both pass. Approximate |
| `DistributedLineStore(kv)` | `watahub:line:` | None | The value is the business token in plain JSON. Encrypt or restrict the store, and never log its values |

### Line tokens

`POST /v1/onboarding/connect` writes the business token to the `LineStore`. With the default `MemoryLineStore`, the
token disappears on restart and, on Workers, exists only in the isolate that handled the call. Pass a
`DistributedLineStore` when tokens must outlive the instance.

### Cloudflare Workers with KV

Cloudflare KV has `put` and `expirationTtl` instead of `set` and `ttlSeconds`, so it needs a small adapter. Build the
app once per isolate, not once per request: `createApp` keeps state of its own (deliveries in flight, the default line
store).

```ts
import { createApp, DistributedLineStore, DistributedReplayStore, type KeyValueStore } from 'watahub'

interface Env {
  WATAHUB_KV: KVNamespace
}

// KV rejects expirations shorter than 60 seconds
function kvStore(namespace: KVNamespace): KeyValueStore {
  return {
    get: (key) => namespace.get(key),
    set: (key, value, options) =>
      namespace.put(key, value, options?.ttlSeconds ? { expirationTtl: Math.max(60, options.ttlSeconds) } : undefined),
    delete: (key) => namespace.delete(key),
  }
}

let app: ReturnType<typeof createApp> | undefined

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= createApp({
      lineStore: new DistributedLineStore(kvStore(env.WATAHUB_KV)),
      replayStore: new DistributedReplayStore(kvStore(env.WATAHUB_KV)),
    })
    return app.fetch(request, env, ctx)
  },
}
```

KV is eventually consistent, so another location can miss a write for a while. That is enough for line tokens and
narrows duplicate deliveries, but your backend must still deduplicate on `x-watahub-delivery-id`. KV also allows about
one write per second to the same key, which makes it a poor fit for rate limits. For those, use a store with atomic
counters, or Cloudflare's own rate limiting rules in front of the Worker.

## 3. Enterprise Edition

Watahub Enterprise Edition (EE) is Hub Ventures' private, commercially licensed multi-tenant gateway. It runs on
Cloudflare Workers with one SQLite Durable Object. It uses the core as a dependency and never patches or forks it:
behavior changes only through what `createApp` accepts.

```mermaid
flowchart LR
  tenant["Tenant API key"] --> guard["EE tenant guard"]
  guard --> core["createApp(coreOverrides)"]
  core --> graph["Meta Graph API"]
  meta["Meta webhooks"] --> eehook["EE /webhook"]
  eehook --> outbox["Durable outbox"]
  outbox --> receivers["Tenant endpoints"]
```

How EE uses the core:

- It installs the published `watahub` package at an exact version.
- Its tenant guard authenticates the tenant's API key and checks that every phone, WABA and media ID belongs to that
  tenant. Only then does it forward the request to the core app, with an internal gateway key and the Meta app
  credentials as bindings.
- Through `coreOverrides` it injects its own `fetch` (an outbound allowlist), `createMetaClient`, a silent `logger` and
  a `lineStore` backed by encrypted records. It turns off the core's per-isolate `RATE_LIMIT_PER_MINUTE`, because EE
  rate-limits per tenant.
- It rejects the operator fallbacks (`META_SYSTEM_USER_TOKEN`, `META_DEFAULT_PHONE_NUMBER_ID`,
  `META_DEFAULT_WABA_ID`), so every call uses the tenant's own token.
- It closes the core's `POST /v1/onboarding/exchange` and `POST /v1/onboarding/override-callback`.
- It serves `/webhook` itself with the core's `verifyMetaSignature`, `isStale` and `normalizeMetaWebhook`, and writes
  each delivery to a durable outbox in the same transaction as its replay receipt.

What only EE has:

| Area | Enterprise Edition |
| :--- | :--- |
| Tenancy | Accounts with their own API keys, phones, WABAs and customers |
| Token custody | Meta tokens and subscriber secrets sealed in the Durable Object; tenants only hold revocable Watahub API keys |
| Delivery | Durable outbox with retries from Durable Object alarms; per-phone destinations and developer webhooks (`X-Webhook-Signature`, `X-Idempotency-Key`) |
| Onboarding | A hosted Embedded Signup page and setup links for customers |
| Interfaces | Superadmin console; installable account panel with overview, inbox, numbers, webhooks, logs and API keys; Web Push for new inbox messages |
| Billing | Prepaid credit; an account that needs payment is paused and cannot send or connect numbers |
| Tooling | CLI and an MCP endpoint over the same API |

Because EE builds on the exports and on `GatewayDeps`, a change to either is a change to EE's contract. Call it out in
the pull request and in the release.
