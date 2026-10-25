# 🚢 Production Deployment Guide

This guide covers deploying Watahub to production across **Cloudflare Workers**, **Node.js (Docker / VPS)**, and **Bun**.

---

## 1. Deployment Matrix

| Feature | Cloudflare Workers | Node.js (Docker / VM) | Bun |
| :--- | :--- | :--- | :--- |
| **Architecture** | Serverless Edge (V8 Isolates) | Long-running Process | Long-running Process |
| **Cold Starts** | 0 ms (Sub-millisecond) | N/A (Always running) | N/A (Always running) |
| **Scalability** | Auto-scales across 300+ edge PoPs | Vertical or horizontal autoscaling | Vertical or horizontal |
| **Memory Limit** | 128 MB (Handled via chunked streams) | Configurable (e.g. 1 GB+) | Configurable |
| **State Storage**| In-memory per isolate or Cloudflare KV | In-memory per process or Redis | In-memory or Redis |
| **Recommended For**| Global latency, low operational overhead | Dedicated VPCs, internal networking | High raw throughput |

---

## 2. Deploying to Cloudflare Workers

Cloudflare Workers is Watahub's primary serverless deployment target.

### Step 1: Install Wrangler CLI
```bash
pnpm install
```

Authenticate with your Cloudflare account:
```bash
npx wrangler login
```

### Step 2: Provision Production Secrets
Secrets must **never** be committed to Git or written in plaintext in `wrangler.jsonc`. Store them securely using `wrangler secret put`:

```bash
# Required for incoming Meta webhook verification
npx wrangler secret put META_APP_SECRET

# Required for Meta challenge handshake
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN

# Required for API authentication on /v1 and /v24.0
npx wrangler secret put WATAHUB_API_KEY

# Required for Meta Graph API calls (System User Token)
npx wrangler secret put META_SYSTEM_USER_TOKEN

# Required for signing subscriber webhook payloads
npx wrangler secret put SUBSCRIBER_WEBHOOK_SECRET
```

### Step 3: Configure Non-Secret Variables (`wrangler.jsonc`)
Set public configuration variables in `wrangler.jsonc`:

```jsonc
{
  "name": "watahub",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "META_API_VERSION": "v24.0",
    "SUBSCRIBER_WEBHOOK_URL": "https://api.yourdomain.com/webhooks/whatsapp",
    "META_DEFAULT_PHONE_NUMBER_ID": "100609346426000",
    "META_DEFAULT_WABA_ID": "105555123456789"
  }
}
```

### Step 4: Deploy
```bash
pnpm run deploy
```

Wrangler outputs your live worker endpoint (e.g. `https://watahub.<subdomain>.workers.dev`).

---

## 3. Deploying to Node.js (Docker / VPS)

For deployments on dedicated Linux servers, AWS EC2, DigitalOcean, or Kubernetes.

### 3.1 Production Dockerfile
Create a multi-stage Docker build:

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check

# Stage 2: Runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

USER node
EXPOSE 3000
CMD ["node", "--loader", "tsx", "src/node.ts"]
```

### 3.2 Docker Compose Recipe
```yaml
version: '3.8'

services:
  watahub:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - META_APP_ID=123456789
      - META_APP_SECRET=${META_APP_SECRET}
      - META_SYSTEM_USER_TOKEN=${META_SYSTEM_USER_TOKEN}
      - META_WEBHOOK_VERIFY_TOKEN=${META_WEBHOOK_VERIFY_TOKEN}
      - WATAHUB_API_KEY=${WATAHUB_API_KEY}
      - SUBSCRIBER_WEBHOOK_URL=${SUBSCRIBER_WEBHOOK_URL}
      - SUBSCRIBER_WEBHOOK_SECRET=${SUBSCRIBER_WEBHOOK_SECRET}
      - TRUSTED_CLIENT_IP_HEADER=X-Real-IP
    restart: unless-stopped
```

### 3.3 Reverse Proxy Configuration (Nginx)
When running behind Nginx or Caddy, configure client body limits and real IP forwarding:

```nginx
server {
    listen 443 ssl http2;
    server_name whatsapp.yourdomain.com;

    # Allow up to 100 MB for WhatsApp document media uploads
    client_max_body_size 100M;

    ssl_certificate /etc/letsencrypt/live/whatsapp.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/whatsapp.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for chunked media streaming
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

> [!IMPORTANT]
> When running behind a reverse proxy, set `TRUSTED_CLIENT_IP_HEADER=X-Real-IP` in Watahub's `.env`. Watahub will accurately key rate limits on the true visitor IP rather than the proxy loopback.

---

## 4. Production Security Checklist

Before publishing your gateway to production:

- [ ] **Strong Keys:** `WATAHUB_API_KEY` and `SUBSCRIBER_WEBHOOK_SECRET` are generated with `openssl rand -hex 32` (at least 32 characters) and never retain default placeholders.
- [ ] **HTTPS Enforced:** All communication with Watahub and `SUBSCRIBER_WEBHOOK_URL` runs over TLS/HTTPS.
- [ ] **Meta Webhook Signature:** `META_APP_SECRET` is set in production so unsigned webhook deliveries are rejected with 503.
- [ ] **Streaming Proxy:** Body size limits are configured on reverse proxies (`client_max_body_size 100M`) without request buffering.
- [ ] **Health Monitoring:** Continuous monitoring queries `GET /health` to confirm gateway status and timestamp fresh receipts.
- [ ] **Subscriber Deduplication:** The subscriber service checks `X-Watahub-Delivery-Id` (or `Idempotency-Key`) to drop redeliveries gracefully.
