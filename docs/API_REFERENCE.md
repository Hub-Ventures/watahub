# API reference

Every route the gateway serves in `watahub` 0.2.0, with its request, response and errors. Source of truth:
`src/routes/`, `src/schemas/` and `tests/routes-contract.test.ts`.

## 1. Conventions

### 1.1 Base URL

`http://localhost:3000` on Node by default, or wherever you deploy the Worker.

### 1.2 Authentication

`/v1/*` and `/v24.0/*` require the gateway key in either header. Both are compared in constant time.

```http
Authorization: Bearer <WATAHUB_API_KEY>
X-API-Key: <WATAHUB_API_KEY>
```

- No key, or a wrong one: `401`.
- From the 11th failed attempt in the same minute, one client gets `429 Too Many Requests` with `Retry-After`. Only
  failed attempts count, so a correct key is never refused.
- `WATAHUB_API_KEY` unset, shorter than 32 characters or still the placeholder: every call answers `503`.

`/health` and `/webhook` take no API key.

### 1.3 Meta access token

Calls that name a phone number ID resolve the Meta token in this order. They are `POST /v1/messages`,
`POST /v1/media`, `POST /v1/media/:phoneNumberId`, `POST /v1/onboarding/override-callback`,
`POST /v24.0/:phoneNumberId/messages` and `POST /v24.0/:phoneNumberId/media`.

1. The `X-Meta-Access-Token` header.
2. The business token that `POST /v1/onboarding/connect` stored for that phone number ID.
3. `META_SYSTEM_USER_TOKEN`.

Calls without a phone number ID skip step 2: `GET /v1/media/:mediaId`, `GET /v1/media/:mediaId/content`,
`GET /v24.0/:mediaId`, `GET /v1/templates` and `POST /v1/onboarding/subscribe`.

With no token, the call answers `500` with
`{ "error": "Missing Meta access token. Set META_SYSTEM_USER_TOKEN or pass X-Meta-Access-Token header." }`.

### 1.4 Error shapes

| When | Status | Body |
| :--- | :--- | :--- |
| Malformed JSON | `400` | `{ "error": "Malformed JSON payload" }` |
| Missing phone number ID or WABA ID | `400` | `{ "error": "Missing phoneNumberId. ..." }` |
| Field validation | `422` | `{ "error": "Validation failed", "details": { "<field>": ["<message>"] } }` |
| Wrong API key | `401` | `{ "error": "Unauthorized: Invalid Watahub API key" }` |
| Proxy path not allowed | `403` | `{ "error": "Endpoint not allowed through the Watahub proxy" }` |
| Unknown route | `404` | `{ "error": "Endpoint not found", "path": "/..." }` |
| Body too large | `413` | `{ "error": "Payload too large" }` |
| Too many failed attempts or requests | `429` | `{ "error": "Too many requests" }`, with `Retry-After` |
| Missing or invalid configuration | `503` | `{ "error": "Gateway misconfigured: ..." }`; never a value |
| Meta answered with an error | Meta's `4xx`/`5xx` | The Meta error envelope below |
| Meta unreachable / timed out | `502` / `504` | `{ "error": { "message": "Meta Graph API unreachable" } }` or `"... request timed out"` |
| Anything else | `500` | `{ "error": { "message": "Internal Server Error" } }` |

The Meta error envelope keeps Meta's code and status and adds a classification. `type` is included only on
`POST /v1/messages`.

```json
{
  "error": {
    "message": "Meta Graph API Error (130429): Rate limit hit",
    "code": 130429,
    "type": "OAuthException",
    "category": "rate_limit",
    "retryable": true,
    "action": "Back off with exponential jitter before retrying request"
  }
}
```

| `category` | Meta codes | `retryable` |
| :--- | :--- | :--- |
| `auth` | `190`, or `100` with subcode `33` | No |
| `billing` | `131042` | No |
| `rate_limit` | HTTP `429`, `4`, `80007`, `130429` | Yes |
| `meta_server` | `1`, `2`, `131000`, `131016`, `133004` | Yes |
| `unknown` | Anything else | No |
| `unknown_outcome` | A message send that may have gone out | No |

Meta's `fbtrace_id` and upstream transport messages are never returned.

**Uncertain send outcome.** A send is not idempotent. When `POST /v1/messages` times out (`504`), loses its connection
to Meta (`502`) or gets a `5xx` from Meta, the message may or may not have been delivered. The status is kept and the
body says so:

```json
{
  "error": {
    "message": "Meta Graph API request timed out",
    "category": "unknown_outcome",
    "retryable": false,
    "action": "The message may have been sent. Confirm it with the status webhook before retrying"
  }
}
```

Confirm with the status webhook before you send again, or the recipient may get the message twice.

### 1.5 Body limits

Bodies are capped while they stream: 1 MB for JSON on `/v1` and the proxy, 3 MB for `POST /webhook`, and 100 MB for
media uploads (`POST /v1/media*` and `POST /v24.0/:phoneNumberId/media`).

## 2. Health

### `GET /health`

No authentication.

```json
{
  "status": "ok",
  "service": "watahub",
  "version": "0.2.0",
  "timestamp": "2026-11-08T15:30:00.000Z"
}
```

## 3. Webhooks

### `GET /webhook`

Meta's subscription handshake.

| Query parameter | Value |
| :--- | :--- |
| `hub.mode` | `subscribe` |
| `hub.verify_token` | Must equal `META_WEBHOOK_VERIFY_TOKEN` |
| `hub.challenge` | Echoed back |

- `200` with `hub.challenge` as plain text.
- `403` when the mode or token is wrong. From the 11th wrong attempt in a minute, one client gets `429`.

### `POST /webhook`

Receives Meta's deliveries. Requires `X-Hub-Signature-256: sha256=<64 hex>` over the raw body, keyed with
`META_APP_SECRET`. The delivery flow is described in [Webhooks and events](WEBHOOKS_AND_EVENTS.md).

| Status | Body | Meaning |
| :--- | :--- | :--- |
| `200` | `{ "status": "received", "eventsCount": n }` | Forwarded (`sync`), queued in the background (`async`), or a delivery without changes |
| `200` | `{ "status": "ignored", "reason": "stale" \| "duplicate", "eventsCount": 0 }` | Too old, already delivered, or a copy of a delivery in progress |
| `200` | `{ "status": "rejected", "reason": "subscriber_rejected", "subscriberStatus": 4xx, "deliveryId": "..." }` | `sync`: your backend refused it for good; not forwarded again |
| `400` | `{ "error": "Invalid JSON payload" }` | Signed, but not JSON |
| `401` | `{ "error": "Invalid HMAC signature" }` | Missing or wrong signature |
| `503` | `{ "error": "Subscriber delivery failed", "deliveryId": "...", ... }` | `sync`: your backend failed or timed out; Meta retries |
| `503` | `{ "error": "Gateway misconfigured: ..." }` | `META_APP_SECRET`, `SUBSCRIBER_WEBHOOK_URL` or `SUBSCRIBER_WEBHOOK_SECRET` missing, or an invalid `WEBHOOK_DELIVERY_MODE` / `META_WEBHOOK_MAX_AGE_SECONDS` |

## 4. Outbound messages

### `POST /v1/messages`

```http
Authorization: Bearer <WATAHUB_API_KEY>
Content-Type: application/json
X-Phone-Number-Id: <optional sender phone number ID>
X-Meta-Access-Token: <optional Meta token>
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `to` | string | Yes | A phone number (`"+15551234567"`; the `+` is removed) or a business-scoped user ID (BSUID, `"US.13491208655302741918"` or `"US.ENT.11815799212886844830"`), up to 135 characters. A BSUID is sent to Meta as `recipient`, unchanged. Authentication templates need a phone number: Meta rejects them for a BSUID with error 131062 |
| `phoneNumberId` | string | No | Sender. Falls back to `X-Phone-Number-Id`, then `META_DEFAULT_PHONE_NUMBER_ID`. Numeric |
| `kind` | string | Yes | `text`, `template`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contacts`, `reaction` or `interactive` |
| `text` | object | For `text` | `{ "body": string }`, 1 to 4096 characters |
| `template` | object | For `template` | `{ "name", "language": { "code" }, "components"? }`; components go to Meta as sent |
| `media` | object | For media kinds | `{ "id" \| "link", "caption"?, "filename"?, "voice"? }`. No caption or filename on `audio` and `sticker`, no filename on `video`, `voice` only on `audio` |
| `location` | object | For `location` | `{ "latitude", "longitude", "name"?, "address"? }` |
| `contacts` | array | For `contacts` | 1 to 10 contact cards in Meta's shape (`name.formatted_name` required) |
| `reaction` | object | For `reaction` | `{ "messageId", "emoji" }`; an empty `emoji` removes the reaction |
| `interactive` | object | For `interactive` | Meta's `interactive` object. `flow`, `cta_url`, `location_request_message`, `product`, `product_list` and `order_details` are validated; `button` and `list` pass through. `poll` is rejected: the Cloud API cannot send polls |
| `replyToMessageId` | string | No | Sent as `context.message_id` |

Unknown fields are dropped.

#### Examples

Text:

```json
{ "to": "+15551234567", "phoneNumberId": "100609346426000", "kind": "text", "text": { "body": "Hello" } }
```

Template:

```json
{
  "to": "+15551234567",
  "kind": "template",
  "template": {
    "name": "order_update",
    "language": { "code": "en_US" },
    "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "ORD-12345" }] }]
  }
}
```

Media, by link or by an uploaded media ID. The same shape works for `audio`, `video`, `document` and `sticker`
within the rules above.

```json
{ "to": "+15551234567", "kind": "image", "media": { "link": "https://example.com/receipt.jpg", "caption": "Receipt" } }
```

Voice note (`audio/ogg; codecs=opus`):

```json
{ "to": "+15551234567", "kind": "audio", "media": { "id": "987654321098765", "voice": true } }
```

Location:

```json
{
  "to": "+15551234567",
  "kind": "location",
  "location": { "latitude": 4.6097, "longitude": -74.0817, "name": "Office", "address": "Cra 7 # 32-16, Bogotá" }
}
```

Reaction:

```json
{ "to": "+15551234567", "kind": "reaction", "reaction": { "messageId": "wamid.HBgL...", "emoji": "👍" } }
```

Reply buttons:

```json
{
  "to": "+15551234567",
  "kind": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "Confirm your appointment?" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "confirm", "title": "Confirm" } },
        { "type": "reply", "reply": { "id": "reschedule", "title": "Reschedule" } }
      ]
    }
  }
}
```

Flow (`flow_message_version` defaults to `"3"` when omitted):

```json
{
  "to": "+15551234567",
  "kind": "interactive",
  "interactive": {
    "type": "flow",
    "body": { "text": "Book a visit" },
    "action": {
      "name": "flow",
      "parameters": {
        "flow_token": "booking-42",
        "flow_id": "1234567890",
        "flow_cta": "Book",
        "flow_action": "navigate",
        "flow_action_payload": { "screen": "START" }
      }
    }
  }
}
```

#### Response (`200`)

```json
{
  "success": true,
  "messageId": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "recipient": "15551234567",
  "phoneNumberId": "100609346426000"
}
```

`recipient` is the value Meta confirms in `contacts[0].input`, or the one the gateway sent.

## 5. Media

### `POST /v1/media` and `POST /v1/media/:phoneNumberId`

Streams a `multipart/form-data` body to Meta's `/{phoneNumberId}/media` as it is, up to 100 MB. The phone number ID
comes from the path, then `X-Phone-Number-Id`, then `?phone_number_id=`, then `META_DEFAULT_PHONE_NUMBER_ID`.

The form is Meta's: `file` (the bytes), `type` (MIME type) and `messaging_product=whatsapp`.

```bash
curl -X POST http://localhost:3000/v1/media/100609346426000 \
  -H "Authorization: Bearer $WATAHUB_API_KEY" \
  -F messaging_product=whatsapp -F type=application/pdf -F file=@invoice.pdf
```

```json
{ "id": "987654321098765" }
```

`400` when the content type is not `multipart/form-data` or no phone number ID is found.

### `GET /v1/media/:mediaId`

Resolves a media ID to Meta's temporary CDN URL.

```json
{
  "mediaId": "987654321098765",
  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=..."
}
```

`?redirect=true` answers `302` to that URL instead. Meta's CDN only serves requests that carry the access token, so a
client that follows the redirect without it gets `401`; use the next route to download.

### `GET /v1/media/:mediaId/content`

Downloads the file through the gateway: it resolves the URL, fetches it with the Meta token and streams the bytes back
with Meta's `Content-Type` and `Content-Disposition`. The caller never holds the Meta token.

- `200`: the bytes.
- `422`: `mediaId` is not numeric.
- `502`: Meta's CDN answered with an error, or Meta returned a URL that is not `https`.

## 6. Templates

### `GET /v1/templates` and `GET /v1/templates/:wabaId`

One page of a WABA's message templates, in Meta's page size.

| Parameter | Where | Description |
| :--- | :--- | :--- |
| `wabaId` | Path or query | Numeric. Falls back to `META_DEFAULT_WABA_ID` |
| `after` | Query | The previous response's `paging.after`. A value that is not a paging cursor (base64, up to 1024 characters) answers `422` |

```json
{
  "data": [
    {
      "id": "1234567890",
      "name": "welcome_message",
      "status": "APPROVED",
      "category": "MARKETING",
      "language": "en_US",
      "components": []
    }
  ],
  "paging": { "after": "QVFIUmx..." }
}
```

Each template is returned as Meta sends it. `paging.after` is present only while Meta has another page; on the last
page `paging` is `{}`. Meta's `paging.next` and `paging.previous` URLs are never returned. Added in 0.2.0; 0.1.0
returned only the first page.

## 7. Embedded Signup and onboarding

`POST /v1/onboarding/connect` is the path to use: the gateway keeps the token. `exchange`, `subscribe` and
`override-callback` stay for existing callers.

### `GET /v1/onboarding/launch`

The public values a frontend needs for `FB.login`. The app secret is never returned.

```json
{ "appId": "236484624622562", "configurationId": "123456789012345", "apiVersion": "v24.0" }
```

`503` when `META_APP_ID` or `META_CONFIGURATION_ID` is missing or not numeric.

### `POST /v1/onboarding/connect`

Finishes Embedded Signup for one phone line. The gateway:

1. Exchanges the code with its own app credentials. Only `client_id`, `client_secret` and `code` go to Meta, in the
   POST body, never the URL.
2. Stores the business token for the phone number ID.
3. Subscribes the WABA to this Meta app's webhook (`messages`). It does not set a callback override.
4. Registers the number for Cloud API with the PIN.

```json
{
  "code": "AQDf58d...",
  "wabaId": "105555123456789",
  "phoneNumberId": "100609346426000",
  "pin": "581063"
}
```

```json
{ "phoneNumberId": "100609346426000", "wabaId": "105555123456789", "subscribed": true, "registered": true }
```

- `400` when `META_APP_ID` or `META_APP_SECRET` is missing (`exchange` too).
- `422` when `pin` is not 6 digits, an ID is not numeric, or the body carries `appId` or `appSecret`.
- If a Graph step fails, the classified Meta error comes back with `"step": "exchange" | "subscribe" | "register"`.
  The token is never in it. After a failed subscribe or register, the stored token stays in place.

### `POST /v1/onboarding/exchange`

Exchanges the code and **returns** the token. Prefer `connect`.

```json
{ "code": "AQDf58d..." }
```

```json
{ "accessToken": "EAAG..." }
```

`appId` and `appSecret` in the body are rejected with `422`: the gateway always uses its own.

### `POST /v1/onboarding/subscribe`

Subscribes this app to a WABA's webhooks with the header token or `META_SYSTEM_USER_TOKEN`. `connect` already does
this with the line's own token.

```json
{ "wabaId": "105555123456789", "subscribedFields": ["messages"] }
```

```json
{ "success": true, "wabaId": "105555123456789" }
```

`subscribedFields` is optional (default `["messages"]`, 1 to 20 entries).

### `POST /v1/onboarding/override-callback`

Points one phone number's webhooks at another URL (Meta's phone-level `override_callback_uri`).

```json
{
  "phoneNumberId": "100609346426000",
  "callbackUrl": "https://hooks.example.com/whatsapp",
  "verifyToken": "<token the other endpoint expects>"
}
```

```json
{ "success": true, "phoneNumberId": "100609346426000" }
```

> [!IMPORTANT]
> `callbackUrl` must be `https` on a public host, without credentials. The gateway rejects `localhost`, single-label
> names, `.local`/`.internal`/`.localhost`/`.home.arpa`, and private, loopback, link-local, CGNAT and reserved IP
> ranges. It checks the host as written and does not resolve DNS.

## 8. Graph proxy

### `/v24.0/*`

Three Graph routes, passed through with the Meta token resolved as in [1.3](#13-meta-access-token). A Graph client
can use them by changing its base URL to the gateway and sending the gateway key in `X-API-Key`. A Meta token the
client sends as `Authorization: Bearer` is not forwarded to Graph; pass it as `X-Meta-Access-Token` instead.

| Method | Path | Query forwarded |
| :--- | :--- | :--- |
| `POST` | `/v24.0/:phoneNumberId/messages` | None |
| `POST` | `/v24.0/:phoneNumberId/media` | None |
| `GET` | `/v24.0/:mediaId` | `phone_number_id` |

- Any other method or path answers `403`. Other query parameters are dropped, because Graph would honor
  `method=`, `fields=` and `access_token=` and widen what the token can do.
- Calls go to `META_API_VERSION` (default `v24.0`), whatever the path prefix says.
- Meta's status and body come back unchanged, without its CORS headers and cookies.
- On `POST .../messages`, a timeout or lost connection answers the gateway's error body with
  `"category": "unknown_outcome"`. A Meta `5xx` keeps Meta's body and adds `X-Watahub-Outcome: unknown`. In both
  cases the message may have gone out.

```bash
curl -X POST http://localhost:3000/v24.0/100609346426000/messages \
  -H "X-API-Key: $WATAHUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "messaging_product": "whatsapp", "to": "15551234567", "type": "text", "text": { "body": "Hello" } }'
```
