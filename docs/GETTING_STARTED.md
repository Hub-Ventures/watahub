# 🚀 Getting Started with Watahub

This guide walks you through setting up Watahub from scratch: configuring your Meta Developer account, launching the gateway locally, sending your first message, and receiving verified webhook events.

---

## 1. Prerequisites

Before starting, ensure you have:

- **Node.js:** Version 20 or higher (`node -v`).
- **pnpm:** Version 9 or higher (`pnpm -v`).
- **Meta for Developers Account:** [developers.facebook.com](https://developers.facebook.com/).
- **WhatsApp Business Account (WABA):** Configured with at least one active phone number.

---

## 2. Meta Developer Account Setup

To connect Watahub to WhatsApp Cloud API, you need credentials from Meta's Developer Portal:

### Step 1: Create a Meta App
1. Log in to [Meta for Developers](https://developers.facebook.com/).
2. Click **My Apps > Create App**.
3. Select **Other** as the use case, then choose **Business** as the app type.
4. Name your app (e.g. `My WhatsApp Gateway`) and link it to your Meta Business Account.

### Step 2: Add WhatsApp Product
1. On the App Dashboard, find **WhatsApp** and click **Set up**.
2. Navigate to **WhatsApp > API Setup**.
3. Note your **Phone Number ID** and **WhatsApp Business Account ID** (WABA ID).
4. Meta provides a temporary access token for testing. For production, generate a permanent **System User Access Token** in Meta Business Manager with permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`

### Step 3: Retrieve Your App Secret
1. Go to **App Settings > Basic**.
2. Click **Show** next to **App Secret**. This secret is required for validating incoming webhook signatures (`X-Hub-Signature-256`).

---

## 3. Local Installation & Configuration

### Step 1: Clone the Repository
```bash
git clone https://github.com/Hub-Ventures/watahub.git
cd watahub
pnpm install
```

### Step 2: Configure Environment Variables
Create your local `.env` file from the provided template:

```bash
cp .env.example .env
```

Generate two strong cryptographic keys (at least 32 characters each):
```bash
# Gateway master API key
openssl rand -hex 32

# Subscriber webhook signing secret
openssl rand -hex 32
```

Edit `.env` and fill in your values:

```ini
# Gateway Server
PORT=3000

# Meta Developer Credentials
META_APP_ID=123456789012345
META_APP_SECRET=your_meta_app_secret_here
META_SYSTEM_USER_TOKEN=your_permanent_system_user_token_here
META_API_VERSION=v24.0

# Optional Defaults
META_DEFAULT_PHONE_NUMBER_ID=100609346426000
META_DEFAULT_WABA_ID=105555123456789

# Webhook Handshake Token (choose a custom string, min 16 characters)
META_WEBHOOK_VERIFY_TOKEN=my_secure_webhook_verify_token_123

# Watahub Master API Key (min 32 characters)
WATAHUB_API_KEY=your_generated_32char_api_key_here

# Subscriber Destination (where Watahub forwards verified, normalized webhooks)
SUBSCRIBER_WEBHOOK_URL=http://localhost:4000/webhook
SUBSCRIBER_WEBHOOK_SECRET=your_generated_32char_subscriber_secret_here
```

---

## 4. Starting Watahub Locally

Start the development server with hot reloading:

```bash
pnpm run dev:node
```

Verify that the gateway is running:
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "watahub",
  "version": "0.1.0",
  "timestamp": "2026-10-25T18:00:00.000Z"
}
```

---

## 5. Connecting Meta Webhooks to Localhost

Meta requires a publicly accessible HTTPS endpoint to send webhook notifications. Use a tunnel like `cloudflared` or `ngrok` during development.

### Option A: Using Cloudflare Tunnel (`cloudflared`)
```bash
pnpm dlx cloudflared tunnel --url http://localhost:3000
```
This generates a URL like `https://random-subdomain.trycloudflare.com`.

### Option B: Using ngrok
```bash
npx ngrok http 3000
```
This generates a URL like `https://random-subdomain.ngrok-free.app`.

### Configure Webhook in Meta Dashboard:
1. In Meta Developer App, go to **WhatsApp > Configuration**.
2. Click **Edit** under **Webhook**.
3. **Callback URL:** `https://<your-tunnel-url>/webhook`
4. **Verify Token:** The exact value of your `META_WEBHOOK_VERIFY_TOKEN`.
5. Click **Verify and Save**. Meta will execute a `GET /webhook` handshake. Watahub verifies the token in constant time and responds with the challenge.
6. Under **Webhook Fields**, click **Manage** and subscribe to `messages`.

---

## 6. Sending Your First WhatsApp Message

Once running, send an outbound message through Watahub's unified `/v1/messages` endpoint:

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer <WATAHUB_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15551234567",
    "phoneNumberId": "100609346426000",
    "kind": "text",
    "text": {
      "body": "Hello from my self-hosted Watahub gateway! 🌊"
    }
  }'
```

Response:
```json
{
  "success": true,
  "messageId": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "recipient": "15551234567",
  "phoneNumberId": "100609346426000"
}
```

---

## 7. Receiving Verified & Normalized Webhooks

When a WhatsApp user sends a message to your number:

1. Meta sends a signed HTTP POST to `https://<your-tunnel-url>/webhook`.
2. Watahub verifies the `X-Hub-Signature-256` header using your `META_APP_SECRET`.
3. Watahub checks replay protection and deduplicates the delivery.
4. Watahub returns `200 OK` to Meta immediately so Meta stops retrying.
5. In the background, Watahub normalizes the payload into clean events and posts it to your `SUBSCRIBER_WEBHOOK_URL`, signed with `X-Watahub-Signature`.

### Example Payload Received by Your Backend:

```json
{
  "timestamp": 1729620000000,
  "events": [
    {
      "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
      "timestamp": 1729620000000,
      "phoneNumberId": "100609346426000",
      "displayPhoneNumber": "15550293848",
      "type": "message",
      "message": {
        "from": "15551234567",
        "senderName": "Jane Doe",
        "kind": "text",
        "text": "Hello Watahub!"
      }
    }
  ],
  "raw": { ... }
}
```

---

## 8. Verifying Code Health

Watahub comes with an automated testing and formatting pipeline. Run the full verification suite before committing:

```bash
pnpm check
```

This runs:
1. `tsc --noEmit` (TypeScript typecheck)
2. `eslint .` (Code quality & style rules)
3. `prettier --check .` (Code formatting)
4. `vitest run --coverage` (Unit & contract tests with >=95% statement and >=90% branch coverage floors)
