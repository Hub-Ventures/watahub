# Contributing to Watahub

Thanks for helping. Watahub is a small gateway that sits between your systems and
Meta's WhatsApp Cloud API, so two things matter more than anything else: it must
stay **secure by default** and **boring to change**. This guide covers both.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in every value; the gateway refuses to boot with placeholders
pnpm dev               # Node, http://localhost:3000
pnpm dev:worker        # Cloudflare Workers via wrangler
```

Node 20+ and pnpm are required. Watahub has no database.

## Before you open a pull request

```bash
pnpm check
```

`check` runs, in order: `typecheck` (sources and tests), `lint` (typescript-eslint,
type-checked), `format:check` (Prettier) and `test:coverage` (Vitest with a coverage
floor of 95% statements/lines/functions and 90% branches). CI and reviewers expect
it green. `pnpm lint:fix` and `pnpm format` fix most style issues.

## How the code is organized

```
src/
  index.ts        createApp(deps): composes middleware and routers, nothing else
  node.ts         Node entry: validates env at boot, then serves
  deps.ts         GatewayDeps: Meta client factory, fetch, clock, logger
  config.ts       constants and the typed per-request config (getConfig)
  logger.ts       Logger port + console default
  clock.ts        Clock port + system default
  http/           HTTP-only helpers: auth, body parsing, error responses,
                  body limits, background work, per-request Meta client
  routes/         one router factory per surface: createXRouter(deps)
  schemas/        zod request schemas (no logic)
  services/       domain logic with no Hono imports: Meta client, retries,
                  errors, crypto, normalizer, subscriber delivery
  types/          Meta wire types and Watahub's public contracts
  utils/          env validation, log redaction, type guards
tests/            Vitest suites; tests/helpers for shared fakes
```

Dependencies point inwards: `routes` → `http` → `services` → `types`. Services never
import from `http` or `routes`, and only `index.ts`, `node.ts` and `deps.ts` decide
which implementation is used.

## Conventions

**Security rules are not refactorable.** These controls are pinned by
`tests/security.test.ts` and must stay as they are unless the change is a
deliberate security decision:

- `/v1/*` and `/v24.0/*` fail closed without a strong `WATAHUB_API_KEY`; keys are compared in constant time.
- `POST /webhook` fails closed without `META_APP_SECRET` and only accepts a valid `sha256=<64 hex>` signature over the raw body.
- Caller input that becomes a Graph path segment must be a numeric Graph ID (`schemas/common.ts`).
- The `/v24.0` proxy forwards only allowlisted routes and query params.
- Responses never echo internal or upstream error messages; logs carry error names only, and request lines go through `redactSecrets`.
- Message sends are never retried after a timeout, network error or 5xx.

If a refactor and a control disagree, the control wins.

**Dependencies are injected.** Anything that talks to the outside world or to
time is a parameter: `createApp({ createMetaClient, fetch, now, logger })`,
`new MetaClient({ fetch, sleep })`, `deliverToSubscriber(req, policy, { fetch, sleep, logger })`,
`normalizeMetaWebhook(payload, now)`. Do not call `fetch`, `Date.now()` or
`console` directly from routes or services; use the injected collaborator.

**Routes stay thin.** A handler parses input (`parseJsonBody`), resolves what it
needs (`metaClientFor`, `getConfig`), calls one service method and maps failures
with `errorResponse`. If two handlers share more than that, the shared part belongs
in `http/` or `services/`.

**Types over casts.** No `any`. Untrusted JSON (Graph responses, webhook bodies,
Worker bindings) is `unknown` until narrowed with a guard (`utils/guards.ts`) or a
zod schema. A cast needs a comment that says why it is safe.

**Named values.** Meta error codes live in `META_ERROR_CODES`; retry timings in a
`RetryPolicy`; limits in `BODY_LIMITS`. No magic numbers in handlers.

**Errors.** Meta failures are `WatahubApiError` and are classified by
`classifyMetaError`; everything else that fails on the way to Meta becomes a
generic 502/504 through `errorResponse`.

**Style.** Prettier decides formatting (no semicolons, single quotes, 120 columns).
Comments explain *why*, not *what*. Imports use the `.js` suffix (NodeNext).

## Tests

- Pin behavior first, then refactor. `tests/routes-contract.test.ts` fixes status
  codes, bodies and the requests sent to Meta for every route; update it only for a
  deliberate contract change and say so in the commit message.
- Prefer injected fakes (`createApp({ createMetaClient: () => fake })`,
  `new MetaClient({ fetch, sleep })`) over spying on globals; tests then run without
  real timers or network.
- Never hit the real Graph API: contract suites make the global `fetch` reject by default.

## Commits and pull requests

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`, `style:`.
- One concern per commit; the body explains why and lists any behavior change.
- Pull requests describe what changed, how it was tested, and any security impact.
