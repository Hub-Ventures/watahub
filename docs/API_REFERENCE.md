# 📡 Watahub API Reference

Complete technical specification for all endpoints exposed by the Watahub Gateway.

---

## 1. Global Conventions

### 1.1 Base URLs
- **Local:** `http://localhost:3000`
- **Cloudflare Workers / Production:** `https://your-watahub-domain.com`

### 1.2 Authentication
All machine-to-machine endpoints (`/v1/*` and `/v24.0/*`) require gateway authentication. Supply your `WATAHUB_API_KEY` using either:

```http
Authorization: Bearer <WATAHUB_API_KEY>
```
or
```http
X-API-Key: <WATAHUB_API_KEY>
```

Calls omitting or providing an invalid API key receive `401 Unauthorized`. Clients exceeding 10 consecutive authentication failures within 60 seconds are throttled with `429 Too Many Requests` and a `Retry-After` header.

### 1.3 Meta Access Token Resolution Priority
For endpoints communicating with Meta's Graph API (`/v1/messages`, `/v1/media`, `/v24.0/*`), Watahub resolves the Meta Access Token in the following order:
1. **Explicit Header:** `X-Meta-Access-Token` provided in the HTTP request (allows callers or wrappers like Enterprise Edition to supply tenant credentials).
2. **Environment Variable:** `META_SYSTEM_USER_TOKEN` (the operator's default token).

If no token is found, the endpoint returns `500 Internal Server Error` with `Missing Meta access token`.

### 1.4 Standard Error Response Envelope
When an error occurs, Watahub returns a structured JSON body:

```json
{
  "error": {
    "message": "Meta Graph API Error (130429): Rate limit exceeded",
    "code": 130429,
    "subcode": 7,
    "type": "OAuthException",
    "category": "rate_limit",
    "retryable": true,
    "action": "Back off with exponential jitter before retrying request"
  }
}
```

**Uncertain send outcome.** A message send is not idempotent. When `POST /v1/messages` times out (`504`), loses its connection to Meta (`502`) or gets a `5xx` from Meta, the message may or may not have been delivered. The status code is kept and the body says so:

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

Confirm the outcome with the message status webhook before sending again, or the recipient may get the message twice.

---

## 2. Health & System

### `GET /health`
Returns service status, version, and server timestamp. Unauthenticated.

#### Request
```bash
curl http://localhost:3000/health
```

#### Response (`200 OK`)
```json
{
  "status": "ok",
  "service": "watahub",
  "version": "0.1.0",
  "timestamp": "2026-10-25T18:00:00.000Z"
}
```

---

## 3. Webhooks

### `GET /webhook`
Handles Meta's initial challenge verification handshake when configuring your webhook in the Meta Developer Portal.

#### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `hub.mode` | `string` | Yes | Must be `"subscribe"` |
| `hub.verify_token` | `string` | Yes | Must match `META_WEBHOOK_VERIFY_TOKEN` |
| `hub.challenge` | `string` | Yes | Random challenge string sent by Meta |

#### Response
- **`200 OK`:** Returns `hub.challenge` as plain text.
- **`403 Forbidden`:** If `hub.verify_token` does not match.

---

### `POST /webhook`
Receives raw incoming webhook events from Meta Cloud API. Validates HMAC signature, checks replay protection, acknowledges Meta immediately, and forwards events asynchronously to `SUBSCRIBER_WEBHOOK_URL`.

#### Required Headers
| Header | Description |
| :--- | :--- |
| `Content-Type` | `application/json` |
| `X-Hub-Signature-256` | Meta's HMAC-SHA256 signature (`sha256=<hex_digest>`) |

#### Request Body
Raw JSON payload from Meta (`whatsapp_business_account` object).

#### Response
- **`200 OK`:** Acknowledges receipt to Meta (`{"status": "received", "eventsCount": 1}`).
- **`401 Unauthorized`:** Invalid or missing `X-Hub-Signature-256`.
- **`503 Service Unavailable`:** Gateway misconfigured (`META_APP_SECRET` or `SUBSCRIBER_WEBHOOK_SECRET` missing).

---

## 4. Outbound Messages

### `POST /v1/messages`
Unified endpoint to dispatch messages to WhatsApp users.

#### Headers
```http
Authorization: Bearer <WATAHUB_API_KEY>
Content-Type: application/json
X-Phone-Number-Id: <optional-phone-number-id>
X-Meta-Access-Token: <optional-override-token>
```

#### Request Schema (`SendMessagePayload`)
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `to` | `string` | Yes | Recipient: a phone number in E.164 format (e.g. `"+15551234567"`), or a business-scoped user ID (BSUID, e.g. `"US.13491208655302741918"` or `"US.ENT.11815799212886844830"`) for users who hide their number. A BSUID is sent to Meta as `recipient` and passed through unchanged. Authentication templates need a phone number: Meta rejects them for a BSUID with error 131062 |
| `phoneNumberId` | `string` | Optional | Sender phone ID (if omitted, uses header or `META_DEFAULT_PHONE_NUMBER_ID`) |
| `tenantId` | `string` | Optional | Tenant identifier for multi-tenant tracing |
| `kind` | `string` | Yes | One of: `text`, `template`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contacts`, `reaction`, `interactive` |

---

### Message Kind Examples

#### 1. Text Message
```json
{
  "to": "+15551234567",
  "phoneNumberId": "100609346426000",
  "kind": "text",
  "text": {
    "body": "Hello from Watahub!"
  }
}
```

#### 2. Template Message (HSM)
```json
{
  "to": "+15551234567",
  "phoneNumberId": "100609346426000",
  "kind": "template",
  "template": {
    "name": "order_update",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "ORD-12345" }
        ]
      }
    ]
  }
}
```

#### 3. Media Message (Link or ID)
```json
{
  "to": "+15551234567",
  "kind": "image",
  "media": {
    "link": "https://example.com/images/receipt.jpg",
    "caption": "Your payment receipt"
  }
}
```
*For audio, video, document, or sticker, replace `"kind": "image"` with the respective kind.*

#### 4. Location Message
```json
{
  "to": "+15551234567",
  "kind": "location",
  "location": {
    "latitude": 37.7749,
    "longitude": -122.4194,
    "name": "San Francisco Office",
    "address": "123 Market St, San Francisco, CA"
  }
}
```

#### 5. Reaction Message
```json
{
  "to": "+15551234567",
  "kind": "reaction",
  "reaction": {
    "messageId": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "emoji": "👍"
  }
}
```

#### 6. Interactive Button Reply
```json
{
  "to": "+15551234567",
  "kind": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "Would you like to confirm your appointment?" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "btn_yes", "title": "Confirm" } },
        { "type": "reply", "reply": { "id": "btn_no", "title": "Reschedule" } }
      ]
    }
  }
}
```

#### Successful Response (`200 OK`)
```json
{
  "success": true,
  "messageId": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "recipient": "15551234567",
  "phoneNumberId": "100609346426000"
}
```

---

## 5. Media Management

### `GET /v1/media/:mediaId`
Resolves a Meta WhatsApp media ID to a temporary downloadable CDN URL.

#### Query Parameters
- `redirect`: (`boolean`, default: `false`). When `true`, returns a `302 Found` redirecting directly to the CDN asset. Meta's CDN only answers requests that carry the access token, so a client that follows the redirect without it gets `401`. To download the file, use `GET /v1/media/:mediaId/content`.
- `phone_number_id`: (`string`, optional). Used to look up the phone's access token if `META_SYSTEM_USER_TOKEN` is unset.

#### Response (`200 OK`)
```json
{
  "mediaId": "123456789012345",
  "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=..."
}
```

---

### `GET /v1/media/:mediaId/content`
Downloads the media file through the gateway. Watahub resolves the CDN URL, fetches it from Meta with the access token, and streams the bytes back with Meta's `Content-Type` (and `Content-Disposition`, if Meta sends one). The caller never needs the Meta token.

#### Responses
- `200 OK`: the file bytes.
- `422`: `mediaId` is not a numeric Graph ID.
- `502`: Meta's CDN answered with an error, or returned a non-`https` URL.
- Errors from the media lookup use the standard error envelope.

---

### `POST /v1/media` and `POST /v1/media/:phoneNumberId`
Uploads a media file to Meta's WhatsApp Cloud API using chunked streaming transfer encoding. Supports files up to 100 MB.

#### Headers
```http
Authorization: Bearer <WATAHUB_API_KEY>
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary...
```

#### Multipart Form Fields
- `file`: The binary media asset.
- `type`: MIME type (e.g. `application/pdf`, `image/png`, `video/mp4`).
- `messaging_product`: `"whatsapp"`.

#### Response (`200 OK`)
```json
{
  "id": "987654321098765"
}
```

---

## 6. Templates Management

### `GET /v1/templates` or `GET /v1/templates/:wabaId`
Lists approved HSM message templates associated with a WhatsApp Business Account.

#### Query / Path Parameters
- `wabaId`: Numeric Meta WABA ID (optional if `META_DEFAULT_WABA_ID` is set).

#### Response (`200 OK`)
```json
{
  "data": [
    {
      "name": "welcome_message",
      "status": "APPROVED",
      "category": "MARKETING",
      "language": "en_US",
      "components": [ ... ]
    }
  ]
}
```

---

## 7. Embedded Signup & Onboarding

### `POST /v1/onboarding/exchange`
Exchanges the short-lived OAuth authorization `code` returned by Meta's Embedded Signup popup for a permanent System User / Page token.

#### Request Body
```json
{
  "code": "AQDf58d...short-lived-oauth-code"
}
```

#### Response (`200 OK`)
```json
{
  "accessToken": "EAAG...permanent-system-user-token"
}
```

---

### `POST /v1/onboarding/subscribe`
Subscribes the gateway application to a WhatsApp Business Account to receive message and status webhooks.

#### Request Body
```json
{
  "wabaId": "105555123456789",
  "subscribedFields": ["messages"]
}
```

#### Response (`200 OK`)
```json
{
  "success": true,
  "wabaId": "105555123456789"
}
```

---

### `POST /v1/onboarding/override-callback`
Configures Meta's phone-level webhook routing to send webhooks for an individual phone number directly to an external URL.

#### Request Body
```json
{
  "phoneNumberId": "100609346426000",
  "callbackUrl": "https://external-service.example.com/webhook",
  "verifyToken": "my_external_verify_token"
}
```

> [!SECURITY]
> `callbackUrl` must resolve to a public HTTPS domain. Localhost, loopback (127.0.0.1), RFC 1918 private subnets, and cloud metadata endpoints (`169.254.169.254`) are strictly rejected.

#### Response (`200 OK`)
```json
{
  "success": true,
  "phoneNumberId": "100609346426000"
}
```

---

## 8. Direct Meta Cloud API Proxy

### `ALL /v24.0/*`
Drop-in passthrough proxy that mirrors Meta's native Graph API endpoints. Enables legacy or third-party WhatsApp SDKs to point directly at Watahub without code changes.

#### Supported Proxy Routes
- `POST /v24.0/:phoneNumberId/messages`
- `POST /v24.0/:phoneNumberId/media`
- `GET /v24.0/:mediaId` (forwards `?phone_number_id=`)

Meta's responses are passed through as they are. For `POST /v24.0/:phoneNumberId/messages`, a timeout or connection failure answers Watahub's error body with `"category": "unknown_outcome"`, and a `5xx` from Meta keeps Meta's body and adds the header `X-Watahub-Outcome: unknown`. In both cases the message may have been delivered: confirm with the status webhook before retrying.

#### Example Proxy Call
```bash
curl -X POST http://localhost:3000/v24.0/100609346426000/messages \
  -H "Authorization: Bearer <WATAHUB_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "+15551234567",
    "type": "text",
    "text": { "body": "Direct proxy message" }
  }'
```
