# Library and shared state

How to use the core as a library, and how to share its state across processes or Worker isolates.

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
| Delivery | `deliverToSubscriber`, `DEFAULT_DELIVERY_POLICY`, `signSubscriberPayload`, `verifySubscriberSignature` and the `Delivery*` types |
| Stores | `MemoryLineStore`, `DistributedLineStore`, `DistributedReplayStore`, `DistributedRateLimitStore`, `cloudflareKvStore` and the `LineStore`, `ReplayStore`, `RateLimitStore`, `StoredLine`, `KeyValueStore`, `KvNamespaceLike` types |
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

The gateway never asks the store for a TTL below 60 s, the Cloudflare KV minimum. Every adapter here is approximate:
reads and writes are separate calls.

| Adapter | Key prefix | TTL | Notes |
| :--- | :--- | :--- | :--- |
| `DistributedReplayStore(kv, ttlSeconds?)` | `watahub:delivery:` | The longer of `ttlSeconds` (default 7 days plus 1 hour) and the webhook window plus 1 hour | The gateway always asks for at least the webhook window, so a shorter `ttlSeconds` has no effect |
| `DistributedRateLimitStore(kv, limit, windowSeconds = 60)` | `watahub:ratelimit:` | The window, and at least 60 s | The value holds `resetAt`, which decides the window, so a key can outlive it by up to 60 s. Read, then write: concurrent requests can both pass, and KV is eventually consistent. Approximate. For exact limits, put an atomic counter (a Durable Object or Redis `INCR`) behind a custom `RateLimitStore` |
| `DistributedLineStore(kv)` | `watahub:line:`, `watahub:line:waba:<wabaId>` | None | `watahub:line:<phoneNumberId>` holds the business token in plain JSON. Encrypt or restrict the store, and never log its values. `watahub:line:waba:<wabaId>` is a pointer: it holds the phone number ID, not the token |

### Line tokens

`POST /v1/onboarding/connect` writes the business token to the `LineStore`. With the default `MemoryLineStore`, the
token disappears on restart. On Workers it would exist only in the isolate that handled the call, so `connect` answers
`503` there instead; `src/worker.ts` stores lines in KV when `WATAHUB_KV` is bound. Pass a `DistributedLineStore` when
tokens must outlive the instance.

`LineStore.findByWaba?(wabaId)` returns the line last put for a WABA. `GET /v1/templates` and
`POST /v1/onboarding/subscribe` use its token when the call sends no `X-Meta-Access-Token`. The method is optional: on
a store without it, those two routes skip the store and use `META_SYSTEM_USER_TOKEN`. Both core stores implement it.

- `MemoryLineStore` keeps a WABA index in memory.
- `DistributedLineStore` writes a second key per line, `<prefix>waba:<wabaId>` (`watahub:line:waba:` by default). It
  holds the phone number ID of that line, never the token. `put` writes the line first, then this pointer.

A line put again under another WABA no longer answers for the old one: the lookup is a miss and the call falls through
to `META_SYSTEM_USER_TOKEN`. A pointer or line that does not parse is a miss too.

### Cloudflare Workers with KV

`src/worker.ts`, the stock Workers entry, already does this for line tokens. With a KV namespace bound as
`WATAHUB_KV`, it builds the app once per isolate with a `DistributedLineStore` over that namespace. Without the
binding, it keeps the defaults and logs an error that names `WATAHUB_KV`.

On Workers, `POST /v1/onboarding/connect` answers `503` when the line store is the default one `createApp` made: the
token would live in one isolate only. It answers before it calls Meta, so the signup code is not used. A
`MemoryLineStore` you pass on purpose is respected. On Node, the default store still connects.

For your own entry, `cloudflareKvStore` adapts a KV namespace to `KeyValueStore`. `set` becomes `put`, a TTL is raised
to at least 60 seconds (the KV minimum), and no TTL means no expiration. Build the app once per isolate, not once per
request: `createApp` keeps state of its own (deliveries in flight, the default line store).

```ts
import { cloudflareKvStore, createApp, DistributedLineStore, DistributedReplayStore } from 'watahub'

interface Env {
  WATAHUB_KV: KVNamespace
}

let app: ReturnType<typeof createApp> | undefined

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    app ??= createApp({
      lineStore: new DistributedLineStore(cloudflareKvStore(env.WATAHUB_KV)),
      replayStore: new DistributedReplayStore(cloudflareKvStore(env.WATAHUB_KV)),
    })
    return app.fetch(request, env, ctx)
  },
}
```

KV is eventually consistent, so another location can miss a write for up to about 60 seconds. That is enough for line
tokens and narrows duplicate deliveries, but your backend must still deduplicate on `x-watahub-delivery-id`. KV also
allows about one write per second to the same key, which makes it a poor fit for rate limits. For those, use a store
with atomic counters, or Cloudflare's own rate limiting rules in front of the Worker.
