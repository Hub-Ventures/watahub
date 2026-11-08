# Deployment

Running the gateway on Cloudflare Workers or on Node.js (directly, in Docker, or behind a reverse proxy). Other
runtimes that can serve a Hono `fetch` handler may work, but they are not tested.

## 1. Runtimes compared

| | Cloudflare Workers | Node.js |
| :--- | :--- | :--- |
| Entry | `src/index.ts` (its default export, `createApp()` with defaults), set as `main` in `wrangler.jsonc` | `src/node.ts`, built to `dist/node.js` |
| Configuration | Bindings: `vars` and secrets | `process.env`; the gateway does not read `.env` files by itself |
| Configuration check | Per request: each route answers `503` while a variable it reads is missing or malformed | At boot: the process exits with the names of the bad variables |
| Client address for rate limits | `CF-Connecting-IP` | The TCP peer, or the last entry of `TRUSTED_CLIENT_IP_HEADER` behind a proxy |
| `async` webhook delivery | `waitUntil` | Tracked in the process; drained for up to 15 s on `SIGTERM` or `SIGINT` |
| Default state (delivered IDs, rate limits, line tokens) | In memory, per isolate | In memory, per process |

With the default in-memory state, each Worker isolate or Node process deduplicates, rate-limits and keeps `connect`
tokens on its own. To share that state, build your own entry with `createApp({ ... })` and the `Distributed*Store`
adapters ([Extensions](MULTI_TENANCY_AND_EXTENSIONS.md)).

## 2. Cloudflare Workers

> [!WARNING]
> The `wrangler.jsonc` in this repository deploys Hub Ventures' own instance: Worker `watahub` on the custom domain
> `api.watahub.dev`. Before you deploy, change `name` and replace or remove `routes`.

1. Install dependencies and sign in to Cloudflare:

   ```bash
   pnpm install
   pnpm exec wrangler login
   ```

2. Store the secrets. Never put them in `wrangler.jsonc`.

   ```bash
   pnpm exec wrangler secret put WATAHUB_API_KEY
   pnpm exec wrangler secret put META_APP_SECRET
   pnpm exec wrangler secret put META_WEBHOOK_VERIFY_TOKEN
   pnpm exec wrangler secret put SUBSCRIBER_WEBHOOK_SECRET
   pnpm exec wrangler secret put META_SYSTEM_USER_TOKEN
   ```

   `META_SYSTEM_USER_TOKEN` is the token every call falls back to. The stock Worker keeps `connect` tokens only in the
   isolate that stored them, so without your own line store you need it (or `X-Meta-Access-Token` on each call).

3. Put the non-secret values in `vars`:

   ```jsonc
   {
     "name": "my-watahub",
     "main": "src/index.ts",
     "compatibility_date": "2026-10-01",
     "compatibility_flags": ["nodejs_compat"],
     "vars": {
       "META_API_VERSION": "v24.0",
       "SUBSCRIBER_WEBHOOK_URL": "https://api.example.com/webhooks/whatsapp",
       "META_DEFAULT_PHONE_NUMBER_ID": "100609346426000",
       "META_DEFAULT_WABA_ID": "105555123456789"
     }
   }
   ```

4. Deploy:

   ```bash
   pnpm run deploy   # wrangler deploy
   ```

5. Point Meta's webhook at `https://<your worker host>/webhook` and check `GET /health`.

`pnpm dev:worker` runs the same Worker locally with `wrangler dev`, which reads local secrets from `.dev.vars`.

## 3. Node.js

```bash
pnpm install --frozen-lockfile
pnpm build                          # tsc to dist/
node --env-file=.env dist/node.js   # or export the variables and run pnpm start
```

`--env-file` needs Node 20.6 or later. `PORT` defaults to `3000`.

### 3.1 Docker

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/node.js"]
```

Keep `node_modules`, `dist`, `.env` and `.git` out of the build context with a `.dockerignore`.

```yaml
services:
  watahub:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    environment:
      TRUSTED_CLIENT_IP_HEADER: X-Real-IP
    restart: unless-stopped
```

### 3.2 Behind a reverse proxy

Allow 100 MB bodies, do not buffer requests (uploads stream to Meta), and pass the client address:

```nginx
server {
    listen 443 ssl http2;
    server_name whatsapp.example.com;

    ssl_certificate     /etc/letsencrypt/live/whatsapp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/whatsapp.example.com/privkey.pem;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

Then set `TRUSTED_CLIENT_IP_HEADER=X-Real-IP`. Without it, every request seems to come from the proxy, and one noisy
client can lock others out of the failed-key budget. Set it only when the proxy overwrites that header: the gateway
trusts its last entry.

## 4. Checklist

- [ ] `WATAHUB_API_KEY` and `SUBSCRIBER_WEBHOOK_SECRET` come from `openssl rand -hex 32` and are stored as secrets.
- [ ] `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` are set; without them `POST /webhook` answers `503` and the
      handshake fails.
- [ ] `SUBSCRIBER_WEBHOOK_URL` is `https`.
- [ ] Your backend verifies `x-watahub-signature` and deduplicates on `x-watahub-delivery-id`.
- [ ] On Workers, the state you need across isolates (line tokens above all) uses a shared store, or you rely on
      `META_SYSTEM_USER_TOKEN`.
- [ ] Behind a proxy, `TRUSTED_CLIENT_IP_HEADER` names a header the proxy sets, and the proxy allows 100 MB bodies.
- [ ] `CORS_ALLOWED_ORIGINS` is empty unless a browser must call the API. The API key must never ship in browser code.
- [ ] Monitoring calls `GET /health`.
