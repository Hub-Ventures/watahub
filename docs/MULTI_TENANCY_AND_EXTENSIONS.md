# 🏢 Multi-Tenancy & Extensibility Guide

This guide explains how to scale Watahub from a single-operator bridge into a multi-tenant hub using the `PhoneDirectory` port and pluggable distributed state store adapters.

---

## 1. Single-Operator vs Multi-Tenant Architecture

Watahub is architected to support two distinct operating models:

| Dimension | Single-Operator Bridge (Default) | Multi-Tenant Hub (via `PhoneDirectory`) |
| :--- | :--- | :--- |
| **Primary Use Case** | A single team or product self-hosting WhatsApp infrastructure. | Multiple clients, agencies, or phone numbers sharing an instance. |
| **Meta Access Token** | Global permanent token (`META_SYSTEM_USER_TOKEN`). | Dynamically resolved per `phoneNumberId` from a database or KV. |
| **Subscriber Webhook** | Single target URL (`SUBSCRIBER_WEBHOOK_URL`). | Dynamically routed to each tenant's specific webhook endpoint. |
| **Signing Secret** | Single global secret (`SUBSCRIBER_WEBHOOK_SECRET`). | Dynamically signed per tenant using their own secret. |
| **Deduplication & Limits**| In-memory process cache (`DeliveryIdCache`). | Distributed Key-Value store (`DistributedReplayStore`). |

---

## 2. The `PhoneDirectory` Port

Watahub models multi-tenancy through the `PhoneDirectory` port in `src/deps.ts`:

```ts
export interface PhoneConfig {
  tenantId?: string
  accessToken?: string
  subscriberUrl?: string
  subscriberSecret?: string
}

export interface PhoneDirectory {
  lookup(phoneNumberId: string): Promise<PhoneConfig | null>
}
```

### 2.1 Inbound Routing Behavior
When a webhook arrives at `POST /webhook`:
1. Watahub extracts `phoneNumberId` from `entry[].changes[].value.metadata.phone_number_id`.
2. It calls `await deps.phoneDirectory.lookup(phoneNumberId)`.
3. If `PhoneConfig` defines `subscriberUrl`:
   - Watahub dispatches events to that specific URL.
   - It signs the payload using `phoneConfig.subscriberSecret` (falling back to `SUBSCRIBER_WEBHOOK_SECRET` if not overridden).
   - It injects `tenantId` into the `SubscriberPayload`.
4. If no phone config exists, it defaults safely to environment variables.

### 2.2 Outbound Token Resolution Behavior
When sending messages (`POST /v1/messages`), uploading media (`POST /v1/media`), or proxying requests (`/v24.0/*`):
1. An explicit `X-Meta-Access-Token` request header **always wins** (caller override).
2. If omitted, Watahub queries `await deps.phoneDirectory.lookup(phoneNumberId)`. If `phoneConfig.accessToken` is present, it is used.
3. If not found, it falls back to `META_SYSTEM_USER_TOKEN`.

---

## 3. Built-In Implementations

Watahub includes two standard implementations out of the box:

### 3.1 `InMemoryPhoneDirectory`
Ideal for testing, development, and single-instance Node.js deployments:

```ts
import { InMemoryPhoneDirectory } from 'watahub'

// Initialize with static map
const directory = new InMemoryPhoneDirectory({
  '100609346426001': {
    tenantId: 'tenant_alpha',
    accessToken: 'EAAG_TOKEN_ALPHA',
    subscriberUrl: 'https://alpha.example.com/webhook',
    subscriberSecret: 'secret_alpha_32chars_min_length',
  },
  '100609346426002': {
    tenantId: 'tenant_beta',
    accessToken: 'EAAG_TOKEN_BETA',
    subscriberUrl: 'https://beta.example.com/webhook',
    subscriberSecret: 'secret_beta_32chars_min_length',
  },
})

// Dynamically register or update a phone
directory.set('100609346426003', {
  tenantId: 'tenant_gamma',
  subscriberUrl: 'https://gamma.example.com/webhook',
})
```

---

### 3.2 `DistributedPhoneDirectory` (Key-Value Backed)
Designed for serverless and distributed edge platforms (Cloudflare Workers, Vercel, AWS Lambda) using any backend conforming to `KeyValueStore`:

```ts
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>
  delete?(key: string): Promise<void>
}
```

```ts
import { DistributedPhoneDirectory, createApp } from 'watahub'

// Example: Cloudflare KV binding
const app = createApp({
  phoneDirectory: new DistributedPhoneDirectory(env.PHONES_KV),
})
```

---

## 4. Distributed State Stores Suite

In serverless environments like Cloudflare Workers, isolate memory resets across invocations. Watahub provides pluggable adapters in `src/services/store-adapters.ts`:

### 4.1 Distributed Replay Protection (`DistributedReplayStore`)
Ensures webhook deduplication works across independent serverless isolates:

```ts
import { DistributedReplayStore, createApp } from 'watahub'

const app = createApp({
  // 24-hour delivery deduplication window across all edge locations
  replayStore: new DistributedReplayStore(env.DELIVERIES_KV, 86400),
})
```

### 4.2 Distributed Rate Limiter (`DistributedRateLimitStore`)
Enforces brute-force braking on failed API keys globally:

```ts
import { DistributedRateLimitStore, createApp } from 'watahub'

const app = createApp({
  apiKeyLimiter: new DistributedRateLimitStore(env.RATELIMIT_KV, 10, 60),
})
```

---

## 5. Custom Enterprise Database Adapter Recipe

To connect Watahub to PostgreSQL, MySQL, Supabase, or Prisma in a custom backend:

```ts
import { Hono } from 'hono'
import { createApp, type PhoneConfig, type PhoneDirectory } from 'watahub'
import { db } from './my-database.js'

class PostgresPhoneDirectory implements PhoneDirectory {
  async lookup(phoneNumberId: string): Promise<PhoneConfig | null> {
    const row = await db.query(
      'SELECT tenant_id, meta_access_token, subscriber_url, subscriber_secret FROM whatsapp_channels WHERE phone_number_id = $1 LIMIT 1',
      [phoneNumberId]
    )

    if (row.rows.length === 0) return null

    const channel = row.rows[0]
    return {
      tenantId: channel.tenant_id,
      accessToken: channel.meta_access_token,
      subscriberUrl: channel.subscriber_url,
      subscriberSecret: channel.subscriber_secret,
    }
  }
}

// Bootstrap Watahub with PostgreSQL directory
export const app = createApp({
  phoneDirectory: new PostgresPhoneDirectory(),
})
```
