# 🔔 Webhooks & Event Normalization Guide

This guide covers how Watahub receives, verifies, normalizes, and delivers WhatsApp events to your application backend.

---

## 1. Webhook Delivery Lifecycle

Meta Cloud API sends webhooks with deeply nested, polymorphic payloads. Watahub acts as an ingestion firewall and normalizer:

1. **Meta Delivery:** Meta sends an HTTP POST to Watahub's `/webhook`.
2. **Signature Verification:** Watahub verifies Meta's `X-Hub-Signature-256` HMAC over the raw byte stream using `META_APP_SECRET`.
3. **Replay & Stale Check:** Deliveries older than `META_WEBHOOK_MAX_AGE_SECONDS` or matching a previously delivered `deliveryId` are acknowledged with `200 OK` but dropped.
4. **Heartbeat Handling:** Empty payloads without changes (e.g. Meta heartbeats) are acknowledged immediately.
5. **Fail-Closed Configuration:** If `SUBSCRIBER_WEBHOOK_URL` or `SUBSCRIBER_WEBHOOK_SECRET` are missing, Watahub returns `503 Service Unavailable` so Meta retries when the configuration is supplied.
6. **Delivery Execution (`WEBHOOK_DELIVERY_MODE`):**
   - **Guaranteed Delivery (`sync`, Default):** Watahub delivers to your subscriber before acknowledging Meta. If your backend is unreachable or returns 5xx, Watahub responds `503 Service Unavailable` to Meta without marking the delivery as seen. Meta automatically retries with exponential backoff for up to 7 days, preventing any event loss.
   - **Asynchronous Delivery (`async`):** For ultra-low latency requirements, Watahub acknowledges Meta immediately with `200 OK` and forwards to your backend in the background using `runInBackground`.
7. **Subscriber Idempotency & Signing:** Every forward carries `X-Watahub-Signature: sha256=...` and a stable `X-Watahub-Delivery-Id` (also mirrored in `Idempotency-Key`).
8. **Graceful Shutdown (Node.js):** When receiving `SIGTERM` or `SIGINT`, the gateway closes incoming connections and awaits active background deliveries (`drainBackgroundTasks`) before terminating.

```mermaid
flowchart TD
    Meta[Meta Webhook] -->|1. POST /webhook| Gateway[🌊 Watahub]
    Gateway -->|2. Verify HMAC & Replays| Check{"Valid?"}
    Check -->|Invalid| Reject["401 / 400"]
    Check -->|Stale / Duplicate| AckDrop["200 OK (Ignored)"]
    Check -->|Fresh| Deliver{"WEBHOOK_DELIVERY_MODE"}
    
    Deliver -->|sync (default)| SyncSub[Forward to Subscriber]
    SyncSub -->|Success 200| Ack200["200 OK to Meta + Remember Replay"]
    SyncSub -->|Failure / 5xx| Retry503["503 Service Unavailable (Meta Retries)"]
    
    Deliver -->|async| AsyncAck["200 OK to Meta"]
    Deliver -->|async| BgTask[runInBackground & drain on SIGTERM]

---

## 2. Verifying the Subscriber Signature

When Watahub forwards a payload to your `SUBSCRIBER_WEBHOOK_URL`, it signs the exact JSON body with HMAC-SHA256 using your `SUBSCRIBER_WEBHOOK_SECRET`.

Header sent:
```http
X-Watahub-Signature: sha256=<hex_encoded_hmac>
X-Watahub-Delivery-Id: <stable_delivery_hash>
Idempotency-Key: <stable_delivery_hash>
```

> [!IMPORTANT]
> You **must** compute the HMAC over the raw request body string before parsing it into a JSON object. Whitespace or key re-ordering changes the digest.

### Implementation Examples

#### Node.js / TypeScript (Express / Fastify / Node http)
```ts
import crypto from 'node:crypto'

export function verifyWatahubSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const providedSignature = signatureHeader.slice('sha256='.length).trim()

  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')

  const expectedBuffer = Buffer.from(computedSignature, 'hex')
  const providedBuffer = Buffer.from(providedSignature, 'hex')

  if (expectedBuffer.length !== providedBuffer.length) return false
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}
```

#### Python (FastAPI / Flask)
```python
import hmac
import hashlib

def verify_watahub_signature(raw_body: bytes, signature_header: str, secret: str) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    provided_signature = signature_header.split("sha256=")[1].strip()
    
    computed_signature = hmac.new(
        secret.encode("utf-8"),
        raw_body,
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(computed_signature, provided_signature)
```

#### Go
```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

func VerifyWatahubSignature(rawBody []byte, signatureHeader, secret string) bool {
	if !strings.HasPrefix(signatureHeader, "sha256=") {
		return false
	}
	providedHex := strings.TrimPrefix(signatureHeader, "sha256=")
	providedBytes, err := hex.DecodeString(providedHex)
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(rawBody)
	expectedBytes := mac.Sum(nil)

	return hmac.Equal(expectedBytes, providedBytes)
}
```

---

## 3. Subscriber Payload Envelope

Every payload forwarded to your subscriber matches the `SubscriberPayload` TypeScript interface:

```ts
export interface SubscriberPayload {
  timestamp: number             // Milliseconds epoch when Watahub processed the delivery
  events: WatahubNormalizedEvent[]
  raw: unknown                  // Full original Meta webhook payload for escape-hatch needs
}
```

---

## 4. Normalized Event Catalog

### 4.1 Inbound Text Message
```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "timestamp": 1729620000000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "message",
  "message": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "from": "573001234567",
    "senderName": "Jane Doe",
    "timestamp": 1729620000000,
    "kind": "text",
    "text": "Hello, I need assistance with my account."
  }
}
```

---

### 4.2 Inbound Image / Media Message
```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "timestamp": 1729620000000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "message",
  "message": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "from": "573001234567",
    "senderName": "Jane Doe",
    "timestamp": 1729620000000,
    "kind": "image",
    "mediaId": "987654321098765",
    "mediaMime": "image/jpeg",
    "mediaSha256": "3a5b...",
    "caption": "Here is the photo of the damaged package"
  }
}
```
*For audio/voice, video, and documents, `kind` will be `"audio"`, `"video"`, or `"document"`. Documents also populate the `filename` property.*

---

### 4.3 Inbound Interactive Button Reply
When a customer taps a quick-reply button:
```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "timestamp": 1729620000000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "message",
  "message": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "from": "573001234567",
    "timestamp": 1729620000000,
    "kind": "interactive",
    "interactiveReply": {
      "type": "button_reply",
      "id": "btn_confirm_order",
      "title": "Confirm Order"
    }
  }
}
```

---

### 4.4 Inbound Interactive List Selection
When a customer selects an option from a dropdown list menu:
```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "timestamp": 1729620000000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "message",
  "message": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "from": "573001234567",
    "timestamp": 1729620000000,
    "kind": "interactive",
    "interactiveReply": {
      "type": "list_reply",
      "id": "item_plan_pro",
      "title": "Pro Tier Plan",
      "description": "Unlimited conversations and analytics"
    }
  }
}
```

**Flow answers (`nfm_reply`).** When a customer submits a WhatsApp Flow, `interactiveReply` has `"type": "nfm_reply"`, the Flow `name` and `body`, and the parsed answer in `responseJson`. If Meta's `response_json` cannot be read as a JSON object, `responseJson` is absent and `"responseJsonError": true` says so, so an unreadable answer is never mistaken for an empty one:

```json
"interactiveReply": {
  "type": "nfm_reply",
  "name": "flow",
  "body": "Sent",
  "responseJsonError": true
}
```

---

### 4.5 Inbound Reaction Message
```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "timestamp": 1729620000000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "message",
  "message": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "from": "573001234567",
    "timestamp": 1729620000000,
    "kind": "reaction",
    "reaction": {
      "targetMessageId": "wamid.ORIGINAL_MESSAGE_ID",
      "emoji": "❤️"
    }
  }
}
```

---

### 4.6 Outbound Mobile Echo (`type: "echo"`)
Triggered when an agent replies directly using the official WhatsApp Business mobile application:
```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "timestamp": 1729620000000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "echo",
  "message": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "from": "15550293848",
    "recipient": "573001234567",
    "timestamp": 1729620000000,
    "kind": "text",
    "text": "Hello, I am replying from the phone.",
    "isEcho": true
  }
}
```

---

### 4.7 Delivery Status Receipt (`type: "status"`)
Fired as messages progress through delivery states (`sent`, `delivered`, `read`, or `failed`):

```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg..._delivered",
  "timestamp": 1729620005000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "status",
  "status": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "recipient": "573001234567",
    "status": "delivered",
    "timestamp": 1729620005000,
    "category": "service"
  }
}
```

#### Failure Status Example:
```json
{
  "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg..._failed",
  "timestamp": 1729620005000,
  "phoneNumberId": "100609346426000",
  "displayPhoneNumber": "15550293848",
  "type": "status",
  "status": {
    "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
    "recipient": "573001234567",
    "status": "failed",
    "timestamp": 1729620005000,
    "errorCode": 131026,
    "errorMessage": "Message undeliverable: User not registered on WhatsApp"
  }
}
```
