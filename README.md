# 🌊 watahub

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Runtime: Hono](https://img.shields.io/badge/Runtime-Hono%20%2F%20Cloudflare-orange?logo=cloudflare)](https://hono.dev/)
[![Tests: Vitest](https://img.shields.io/badge/Tests-Vitest-yellow?logo=vitest)](https://vitest.dev/)

> **What a hub for WhatsApp!**  
> An open-source, high-performance WhatsApp Cloud API Gateway and Infrastructure (IaaS) built with [Hono](https://hono.dev). Connect your apps directly to Meta Cloud API with **zero middleman markups**, multi-tenant Embedded Signup, instant webhook normalization, cryptographic signature validation, and phone-level callback routing.

Built with ❤️ by [Hub Ventures](https://github.com/Hub-Ventures).

---

## ⚡ Why Watahub?

Most WhatsApp gateway providers charge extra message markups, enforce vendor lock-in, or add unnecessary latency. **Watahub** is designed as a direct self-hostable bridge between Meta's Graph API and your application ecosystem:

* 🚀 **Zero Middleman Markup:** Pay only Meta's official conversation rates directly.
* ⚡ **Ultra-lightweight & Fast:** Built on Hono with Web Standards (`crypto.subtle`, `fetch`), running seamlessly on **Cloudflare Workers**, **Node.js**, or **Bun**.
* 🔐 **Cryptographic Verification:** Automatic HMAC-SHA256 verification of incoming Meta webhooks (`X-Hub-Signature-256`) and outgoing subscriber payload signing (`X-Watahub-Signature`).
* 🔄 **Event Normalization:** Transforms Meta's deeply nested webhook structures into clean, standardized event payloads (text, audio, images, documents, interactive button/list replies, delivery status receipts).
* 🏢 **Embedded Signup & Multi-Tenant:** Direct support for OAuth code exchange, WABA subscription, and per-phone webhook callback overrides.
* 🛡️ **Production-Hardened Error Engine:** Automated categorization of Meta Graph API errors (Rate Limits `130429`, Auth Expiry `190`, Billing/Payment Failures `131042`, Transient Failures `131016`).

---

## 📐 Architecture

```mermaid
flowchart LR
    User["WhatsApp User"] <--> Meta["Meta Cloud API (v24.0)"]
    Meta <--> Watahub["🌊 Watahub Gateway (Hono)"]
    Watahub <--> Cautia["Product Backend (e.g. Cautia)"]
```

---

## 📦 Quick Start

### 1. Installation

```bash
git clone https://github.com/Hub-Ventures/watahub.git
cd watahub
pnpm install
```

### 2. Environment Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Configure your environment variables:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Local Node.js server port | `3000` |
| `META_APP_ID` | Meta Developer App ID | - |
| `META_APP_SECRET` | **Required.** Meta App Secret, used to verify `X-Hub-Signature-256`. Without it `POST /webhook` answers 503 | - |
| `META_SYSTEM_USER_TOKEN` | Meta System User permanent access token | - |
| `META_WEBHOOK_VERIFY_TOKEN` | **Required.** Token for Meta's webhook handshake (min 16 characters) | - |
| `META_DEFAULT_PHONE_NUMBER_ID` | Default WhatsApp Business Phone Number ID | - |
| `META_DEFAULT_WABA_ID` | Default WhatsApp Business Account ID | - |
| `META_API_VERSION` | Graph API Version | `v24.0` |
| `WATAHUB_API_KEY` | **Required.** Key for every `/v1/*` and `/v24.0/*` call (min 32 characters, `openssl rand -hex 32`). Without it those routes answer 503 | - |
| `SUBSCRIBER_WEBHOOK_URL` | Forwarding destination URL (https; `http://localhost` allowed for development) | - |
| `SUBSCRIBER_WEBHOOK_SECRET` | Required with `SUBSCRIBER_WEBHOOK_URL`. Signs deliveries (min 32 characters) | - |
| `META_WEBHOOK_MAX_AGE_SECONDS` | Signed deliveries whose newest event is older than this are acknowledged but not forwarded | `604800` (7 days) |
| `RATE_LIMIT_PER_MINUTE` | Optional per-client request limit on `/v1/*` and `/v24.0/*` | off |
| `TRUSTED_CLIENT_IP_HEADER` | Header with the real client IP when Node runs behind a reverse proxy (e.g. `X-Real-IP`) | - |
| `CORS_ALLOWED_ORIGINS` | Comma-separated exact origins allowed from browsers. No wildcards | off |

On Node the gateway validates this configuration at boot and refuses to start if a required value is missing, too short or still the `.env.example` placeholder. Cloudflare Workers has no boot step, so the same rules are enforced per request on the routes they protect.

--- | :--- | :--- |
| `PORT` | Local Node.js server port | `3000` |
| `META_APP_ID` | Meta Developer App ID | - |
| `META_APP_SECRET` | Meta Developer App Secret (used for HMAC verification) | - |
| `META_SYSTEM_USER_TOKEN` | Meta System User permanent access token | - |
| `META_WEBHOOK_VERIFY_TOKEN` | Custom token for Meta webhook handshake | - |
| `META_DEFAULT_PHONE_NUMBER_ID` | Default WhatsApp Business Phone Number ID | - |
| `META_DEFAULT_WABA_ID` | Default WhatsApp Business Account ID | - |
| `META_API_VERSION` | Graph API Version | `v24.0` |
| `SUBSCRIBER_WEBHOOK_URL` | Forwarding destination URL (e.g. your backend) | - |
| `SUBSCRIBER_WEBHOOK_SECRET` | Shared secret to sign subscriber deliveries | - |
| `WATAHUB_API_KEY` | Optional API key to protect `/v1/*` routes | - |

---

## 🚀 Running Watahub

### Development (Node.js)
```bash
pnpm run dev:node
```

### Development (Cloudflare Workers via Wrangler)
```bash
pnpm run dev:worker
```

### Typecheck, Lint & Test Suite
```bash
pnpm check   # typecheck + lint + format check + tests with coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout and conventions.

### Deploy to Cloudflare Workers
```bash
pnpm run deploy
```

---

## 📡 API Reference

### 1. Gateway Health
* `GET /health`  
Returns service status, version, and server timestamp.

### 2. Webhooks
* `GET /webhook`  
Handles Meta's initial challenge handshake verification (`hub.mode`, `hub.verify_token`, `hub.challenge`).
* `POST /webhook`  
Receives raw webhooks from Meta, verifies `X-Hub-Signature-256`, normalizes events, dispatches them asynchronously to `SUBSCRIBER_WEBHOOK_URL`, and returns an immediate `200 OK`.

### 3. Outbound Messages
* `POST /v1/messages`  
Unified endpoint to send text, templates, media, reactions, and interactive components.

**Sample Request (Text Message):**
```json
POST /v1/messages
Content-Type: application/json
Authorization: Bearer <WATAHUB_API_KEY>

{
  "to": "+15551234567",
  "phoneNumberId": "100609346426000",
  "kind": "text",
  "text": {
    "body": "Hello from Watahub!"
  }
}
```

**Sample Request (Template Message):**
```json
POST /v1/messages
Content-Type: application/json

{
  "to": "+15551234567",
  "phoneNumberId": "100609346426000",
  "kind": "template",
  "template": {
    "name": "welcome_confirmation",
    "language": {
      "code": "es"
    }
  }
}
```

### 4. Template Management
* `GET /v1/templates/:wabaId`  
Lists approved HSM templates directly from Meta Graph API.

### 5. Onboarding & Multi-Tenancy
* `POST /v1/onboarding/exchange`: Exchanges Meta Embedded Signup `code` for an access token (body: `{ "code": "..." }`; uses the gateway's own Meta app).
* `POST /v1/onboarding/subscribe`: Subscribes application to WABA message webhooks.
* `POST /v1/onboarding/override-callback`: Overrides webhook routing URL for an individual phone number.

---

## 🔒 Security model

* **Authentication.** `/v1/*` and `/v24.0/*` require `WATAHUB_API_KEY` in `X-API-Key` or `Authorization: Bearer`, compared in constant time. Keys must be at least 32 characters, which is what makes guessing impractical. A client address with more than 10 failed attempts in a minute gets `429` with `Retry-After` for further wrong keys (separate counter for wrong `hub.verify_token` guesses on `GET /webhook`). A correct key is never refused, so callers that share an address with a guesser keep working.
* **Inbound webhooks.** `POST /webhook` only accepts bodies with a valid `X-Hub-Signature-256`. Meta's signature has no timestamp, so the gateway also drops replays: a body the subscriber already confirmed is not forwarded again, and deliveries whose newest event is older than `META_WEBHOOK_MAX_AGE_SECONDS` are acknowledged with `200` but not forwarded.
* **Outbound deliveries.** With `SUBSCRIBER_WEBHOOK_URL` set and no `SUBSCRIBER_WEBHOOK_SECRET`, `POST /webhook` answers `503` so Meta keeps retrying until the secret is configured. Every forward to `SUBSCRIBER_WEBHOOK_URL` carries `X-Watahub-Signature: sha256=<HMAC-SHA256(body, SUBSCRIBER_WEBHOOK_SECRET)>` and `X-Watahub-Delivery-Id` (also sent as `Idempotency-Key`). Your backend should verify the signature over the raw body, reject bodies whose `timestamp` field (ms) is more than a few minutes old, and dedupe on the delivery ID. Redirects are not followed.
* **Graph proxy.** `/v24.0` forwards only `POST /{id}/messages`, `POST /{id}/media` and `GET /{id}`, with numeric IDs and only the `phone_number_id` query parameter.
* **Callback overrides.** `callbackUrl` must be `https://` on a public host: loopback, private, link-local and internal names are rejected.
* **Embedded Signup.** `POST /v1/onboarding/exchange` takes only `code` and always uses `META_APP_ID` / `META_APP_SECRET` (sending `appId` or `appSecret` is a `422`). The secret goes to Graph in a POST body, not the URL. Responses on `/v1` and `/v24.0` are `Cache-Control: no-store`.
* **HTTP.** Security headers (deny-all CSP, `X-Frame-Options: DENY`, HSTS, `nosniff`) on every response. CORS is off unless `CORS_ALLOWED_ORIGINS` is set.
* **Limits.** Request bodies are capped (webhook 3 MB, JSON 1 MB, media upload 100 MB). The rate limiter and replay cache live in memory: per process on Node, per isolate on Workers. For a global limit on Workers, add Cloudflare rate limiting rules in front. Behind a reverse proxy on Node, set `TRUSTED_CLIENT_IP_HEADER`; for `X-Forwarded-For` the last entry (written by your proxy) is used.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
