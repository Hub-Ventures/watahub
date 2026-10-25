# 🏢 Extensibility, Distributed Stores & Enterprise Edition (/ee)

This guide explains how Watahub is architected across its **Open-Source Core** and the **Enterprise Edition (`/ee`)**, and how to scale core deployments using pluggable distributed stores.

---

## 1. Core vs. Enterprise Edition Architecture

| Dimension | Open-Source Core (MIT) | Enterprise Edition (`/ee`, Private Repo) |
| :--- | :--- | :--- |
| **Tenancy Model** | **Single Operator** (Dedicated team or backend). | **Multi-Tenant** (Multiple clients, agencies, or phone numbers). |
| **Meta Access Token** | Configured via `META_SYSTEM_USER_TOKEN` or dynamic caller override `X-Meta-Access-Token`. | Dynamically resolved per tenant and authenticated phone number. |
| **Subscriber Webhook** | Single target URL (`SUBSCRIBER_WEBHOOK_URL`). | Dynamically routed to each tenant's dedicated webhook URL. |
| **Subscriber HMAC Secret** | Single global secret (`SUBSCRIBER_WEBHOOK_SECRET`). | Signed using tenant-specific signing secrets. |
| **API Keys & Ownership** | Single operator `WATAHUB_API_KEY`. | Dedicated tenant API keys with route-level phone ownership enforcement. |
| **Package & Usage** | Standalone gateway server or importable TypeScript library. | Platform wrapper importing core building blocks. |

---

## 2. Consuming Watahub as an Importable Library

Watahub is published with full TypeScript declarations (`types: dist/index.d.ts` and `exports` in `package.json`). You can import its core components directly to build custom gateways, serverless handlers, or enterprise platforms:

```ts
import {
  createApp,
  verifyMetaSignature,
  normalizeMetaWebhook,
  deliverToSubscriber,
  MetaClient,
  type GatewayDeps,
  type WatahubNormalizedEvent,
} from 'watahub'

// 1. Instantiate the gateway app with custom collaborators
const app = createApp({
  fetch: customFetchEngine,
  now: () => Date.now(),
})

// 2. Or use individual building blocks in your own server
const isAuthentic = await verifyMetaSignature(rawBody, signatureHeader, appSecret)
const events = normalizeMetaWebhook(rawMetaPayload)
```

---

## 3. Distributed State Stores Suite (Core)

In distributed serverless environments (such as Cloudflare Workers with multi-isolate execution) or cluster deployments, memory is not shared across isolates. Watahub provides pluggable distributed store adapters in `src/services/store-adapters.ts`:

### 3.1 `KeyValueStore` Contract
All distributed stores accept any storage engine conforming to this minimal asynchronous contract:

```ts
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>
  delete?(key: string): Promise<void>
}
```

### 3.2 Distributed Replay Protection (`DistributedReplayStore`)
Deduplicates webhook deliveries across edge isolates using TTL-based expiration:

```ts
import { DistributedReplayStore, createApp } from 'watahub'

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      // 24-hour delivery deduplication window across all edge locations
      replayStore: new DistributedReplayStore(env.DELIVERIES_KV, 86400),
    })
    return app.fetch(req, env, ctx)
  },
}
```

### 3.3 Distributed Rate Limiter (`DistributedRateLimitStore`)
Enforces brute-force attack prevention on invalid API keys globally:

```ts
import { DistributedRateLimitStore, createApp } from 'watahub'

const app = createApp({
  apiKeyLimiter: new DistributedRateLimitStore(env.RATELIMIT_KV, 10, 60),
})
```

---

## 4. How Enterprise Edition (`/ee`) Wraps Core

Enterprise Edition does not modify the core engine; it **wraps** it as a higher-level platform:

1. **Authentication Layer:** Inspects incoming client API keys, authenticates the tenant, and validates that requested `phoneNumberId` belongs to the tenant.
2. **Credential Injection:** Looks up the tenant's WhatsApp token in its `PhoneDirectory` (PostgreSQL, KV, or Redis) and injects it into the request as an `X-Meta-Access-Token` header before passing it to the core router.
3. **Dedicated Webhook Dispatch:** Intercepts incoming Meta webhooks, verifies HMAC and normalizes payloads using core's `verifyMetaSignature` and `normalizeMetaWebhook`, and dispatches directly to the specific tenant's endpoint with their private secret.
