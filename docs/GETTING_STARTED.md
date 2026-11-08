# Getting started

From an empty checkout to a sent message and a received webhook. Takes a Meta app, a WhatsApp Business Account (WABA)
with a phone number, and a public HTTPS URL for the webhook.

## 1. Prerequisites

- Node.js 20 or later (`node -v`).
- pnpm. Run `corepack enable` once; it uses the pnpm version pinned in `package.json` (`packageManager`).
- A [Meta for Developers](https://developers.facebook.com/) account and a WABA with at least one phone number.
- A tunnel for local webhooks, such as `cloudflared` or `ngrok`.

## 2. Meta app

1. In Meta for Developers, create an app with the WhatsApp product and link it to your business portfolio.
2. In the WhatsApp API setup page, note the **phone number ID** and the **WhatsApp Business Account ID**. Both are
   numeric; the gateway rejects anything else.
3. In **App settings > Basic**, copy the **App secret**. The gateway uses it to verify `X-Hub-Signature-256` on every
   webhook.
4. Choose how the gateway gets a Meta token:
   - **System user token.** Create a permanent system user token in Meta Business Manager with
     `whatsapp_business_messaging` and `whatsapp_business_management` and set it as `META_SYSTEM_USER_TOKEN`. Meta's
     temporary test token works for a first try but expires.
   - **Embedded Signup.** Leave `META_SYSTEM_USER_TOKEN` empty and connect each line with
     `POST /v1/onboarding/connect` (step 8). This also needs `META_APP_ID` and an Embedded Signup configuration
     (`META_CONFIGURATION_ID`).

## 3. Install and configure

```bash
git clone https://github.com/Hub-Ventures/watahub.git
cd watahub
pnpm install
cp .env.example .env
```

Generate the gateway API key and the subscriber signing secret:

```bash
openssl rand -hex 32   # WATAHUB_API_KEY
openssl rand -hex 32   # SUBSCRIBER_WEBHOOK_SECRET
```

Edit `.env`. The values below are examples.

```ini
PORT=3000

META_APP_ID=123456789012345
META_APP_SECRET=<app secret>
META_SYSTEM_USER_TOKEN=<system user token>
META_API_VERSION=v24.0

# Used when a call names no phone number or WABA
META_DEFAULT_PHONE_NUMBER_ID=100609346426000
META_DEFAULT_WABA_ID=105555123456789

# 16+ characters; you type the same value into Meta's webhook settings
META_WEBHOOK_VERIFY_TOKEN=<verify token>

# 32+ characters
WATAHUB_API_KEY=<openssl rand -hex 32>

# Where verified, normalized events are forwarded; http is allowed only for localhost and 127.0.0.1
SUBSCRIBER_WEBHOOK_URL=http://localhost:4000/webhook
SUBSCRIBER_WEBHOOK_SECRET=<openssl rand -hex 32>
```

The full list, with defaults and rules, is in the [README](../README.md#configuration).

## 4. Run

```bash
pnpm exec tsx watch --env-file=.env src/node.ts
```

This runs `src/node.ts` and reloads on change. The gateway reads `process.env` and does not load `.env` by itself;
`--env-file` (Node 20.6 or later) does. `pnpm dev` runs the same file without it, so it only works when the variables
are already exported in your shell.

At boot, `src/node.ts` checks the configuration and exits with the name of every variable that is missing, too short,
malformed or still the `.env.example` placeholder. It never prints the values.

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "service": "watahub",
  "version": "0.2.0",
  "timestamp": "2026-11-08T15:30:00.000Z"
}
```

## 5. Expose the webhook

Meta only calls public HTTPS URLs. Start a tunnel to port 3000:

```bash
cloudflared tunnel --url http://localhost:3000   # https://<random>.trycloudflare.com
ngrok http 3000                                  # https://<random>.ngrok-free.app
```

In the Meta app's WhatsApp configuration:

1. Set **Callback URL** to `https://<tunnel host>/webhook`.
2. Set **Verify token** to the value of `META_WEBHOOK_VERIFY_TOKEN`.
3. Choose **Verify and save**. Meta calls `GET /webhook`; the gateway compares the token in constant time and answers
   the challenge. After 10 wrong tokens in a minute from one client it answers `429`.
4. Subscribe to the `messages` webhook field.

## 6. Send a message

```bash
curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer $WATAHUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+15551234567",
    "phoneNumberId": "100609346426000",
    "kind": "text",
    "text": { "body": "Hello from my Watahub gateway" }
  }'
```

```json
{
  "success": true,
  "messageId": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
  "recipient": "15551234567",
  "phoneNumberId": "100609346426000"
}
```

Outside the 24-hour customer service window, Meta only accepts template messages. The other kinds are in the
[API reference](API_REFERENCE.md#4-outbound-messages).

## 7. Receive a message

When someone writes to your number:

1. Meta posts the event to `https://<tunnel host>/webhook` with `X-Hub-Signature-256`.
2. The gateway verifies the signature with `META_APP_SECRET` and drops stale or already-delivered bodies.
3. It normalizes the event and posts `{ timestamp, events, raw }` to `SUBSCRIBER_WEBHOOK_URL`, signed with
   `x-watahub-signature`.
4. By default (`WEBHOOK_DELIVERY_MODE=sync`) it answers Meta only after your backend answers: `200` when your backend
   accepts it, `503` when it fails or takes longer than 3 seconds, so Meta delivers it again.

Your backend receives:

```json
{
  "timestamp": 1762615800000,
  "events": [
    {
      "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
      "timestamp": 1762615800000,
      "phoneNumberId": "100609346426000",
      "displayPhoneNumber": "15550293848",
      "type": "message",
      "message": {
        "id": "wamid.HBgLNTczMDAxMjM0NTY3FQIAEhgg...",
        "from": "15551234567",
        "senderName": "Jane Doe",
        "timestamp": 1762615800000,
        "kind": "text",
        "text": "Hello"
      }
    }
  ],
  "raw": { "object": "whatsapp_business_account", "entry": [] }
}
```

Verify the signature before you trust the body, and deduplicate on `x-watahub-delivery-id`. Both are covered in
[Webhooks and events](WEBHOOKS_AND_EVENTS.md).

## 8. Connect a line with Embedded Signup (optional)

Instead of a system user token, a line can be connected through Meta's Embedded Signup. The gateway then stores that
line's business token and never returns it.

1. Your backend calls `GET /v1/onboarding/launch` (it needs the API key) and hands `appId` and `configurationId` to
   the frontend for `FB.login`.
2. When the signup finishes, send the code, the WABA ID, the phone number ID and a 6-digit PIN for two-step
   verification to `POST /v1/onboarding/connect`.
3. The gateway exchanges the code with its own app credentials, stores the token for that phone number ID, subscribes
   the WABA to this app's webhook (`messages`) and registers the number.

The default line store is in memory. Tokens are lost on restart, and on Workers they live only in one isolate. Pass a
shared store before you rely on it: see [Extensions](MULTI_TENANCY_AND_EXTENSIONS.md#line-tokens).

## 9. Check the code

```bash
pnpm check
```

It runs, in order: `tsc` over sources and tests, ESLint, Prettier, and Vitest with coverage. Coverage must stay at or
above 95% of statements, lines and functions and 90% of branches.
