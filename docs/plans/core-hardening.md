# Core hardening plan

Status: approved 2026-11-17. The owner asked to run it in parallel sessions, one per finding. D1, D2 and D3 follow
the recommendations below. Written 2026-11-17 after a review of the core at `61f1005`.

Five findings. Finding 2 is in progress in a separate branch. This plan implements 1, 3, 4 and 5, one session and
one commit per finding, with `pnpm check` green after each. The branches merge into `claude/core-hardening-5dec65`
(see [Parallel work](#parallel-work)).

Baseline: `pnpm check` passes with 447 tests, 99.7% statements and 95% branches (floor 95/90). The suites stub
`fetch` and never call Meta.

## Contract rules

Watahub Enterprise Edition (`watahub-ee`) installs the published package and wraps it. It never patches it. Every
change to an exported function or type, or to a `GatewayDeps` or `LineStore` port, is a change to EE's contract.
So:

- Every change to something exported is backward compatible: new members are optional, defaults keep today's
  behavior for a caller that does not opt in.
- Each commit message has an `EE contract:` paragraph. It says what changed or `none`.
- No change to `src/utils/env.ts`, to the env validation block at the top of the `GET` and `POST /webhook` handlers in
  `src/routes/webhook.ts`, to `tests/env-workers.test.ts` or to `tests/env.test.ts`. Finding 2 owns them.

## Decisions for the owner

These three are the owner's. Each had a recommendation; the owner approved the plan with them on 2026-11-17.
Everything else in this plan follows from the findings.

| # | Question | Decision |
| :--- | :--- | :--- |
| D1 | Production `wrangler.jsonc`: point `main` at the new `src/worker.ts`, and add the `WATAHUB_KV` binding now? | Point `main` at `src/worker.ts` now. Add the `kv_namespaces` block **commented out**, with the create command next to it. Uncomment it after the namespace exists. A placeholder `id` would make the next `wrangler deploy` fail |
| D2 | On Workers, keep delivered IDs (replay) and rate limits in KV too, or only line tokens? | Only line tokens. Replay and rate limits stay per isolate, as documented today. See finding 1, options |
| D3 | Change the default `WEBHOOK_DELIVERY_MODE` (`sync`) or the 3 s `sync` timeout? | Keep both. Fix it with guidance and a clear log line instead. See finding 3 |

## Finding 1. In-memory state on the stock Workers deploy

### Problem

- `wrangler.jsonc:3` deploys `src/index.ts`. Its default export is `createApp()` with defaults (`src/index.ts:115-117`),
  served on `api.watahub.dev` (`wrangler.jsonc:13-16`).
- `createDefaultDeps` uses in-memory stores: `MemoryLineStore` (`src/deps.ts:101`), the module-level
  `DeliveryIdCache` (`src/deps.ts:98`, `src/services/replay.ts:106`) and `FixedWindowLimiter`s
  (`src/deps.ts:99-100`, `src/http/rate-limit.ts:132-133`, `src/http/rate-limit.ts:140-162`).
- `POST /v1/onboarding/connect` stores the business token (`src/services/line-connect.ts:62`) and answers success.
  The token lives only in that isolate. The next request lands in another isolate, misses the store
  (`src/http/auth.ts:69-72`) and falls back to `META_SYSTEM_USER_TOKEN`, or answers `500`.
- Replay protection and rate limits are also per isolate.
- The README warns about it (`README.md:248-252`, also `docs/DEPLOYMENT.md:44-45`), but the stock deploy is the
  unsafe one, and `connect` reports a success that does not hold.

### Options

| Option | For | Against |
| :--- | :--- | :--- |
| A. Docs only | No code | `connect` keeps answering a success that does not hold |
| B. Workers entry with KV for line tokens, plus fail closed | Tokens are written once and read on every send: the access pattern KV is built for. Small, Cloudflare-native | KV is eventually consistent: a new line can take up to about 60 s to be visible in other locations |
| C. B, plus KV for replay | Narrows duplicate forwards across isolates | One KV write per delivered webhook (the free plan allows 1,000 writes a day). A failed write after a delivery turns into a `500`, and Meta redelivers anyway. Eventual consistency leaves the same gap for redeliveries inside about 60 s. Subscribers must dedupe on `x-watahub-delivery-id` either way |
| D. B, plus KV for rate limits | Shared limit | KV allows about 1 write per second per key. A client failing auth faster than that makes `hit` throw and get `500`. Read-then-write is not atomic (finding 5) |
| E. Durable Objects for everything | Strongly consistent and atomic: exact replay and rate limits | A DO class and a migration in `wrangler.jsonc`, Cloudflare-only code in the MIT core, and a round trip to one location on every send. EE already runs on a SQLite Durable Object |

### Decision (recommended)

B now. C, D and E later. This is D2.

- New Workers entry `src/worker.ts`. On the first request of an isolate it builds the app from that request's `env`
  and keeps it for the isolate. With a `WATAHUB_KV` binding, the line store is a `DistributedLineStore` over KV.
  Without it, it keeps the defaults and logs one error naming `WATAHUB_KV`.
- Fail closed: on the Workers runtime, `POST /v1/onboarding/connect` answers `503` **before** the code exchange when
  the line store is the default one `createDefaultDeps` created. A `MemoryLineStore` the caller passes on purpose is
  respected. Node is unchanged: one process keeps its tokens until restart, as documented.
- Rate limits stay per isolate. Docs keep pointing to Cloudflare rate limiting rules for a global limit.
- Replay stays per isolate. Subscribers keep deduplicating on `x-watahub-delivery-id` (finding 3 makes that
  guidance explicit).

### Changes by file

- `src/services/cloudflare-kv.ts` (new): `KvNamespaceLike` (the three `KVNamespace` methods the gateway uses, so the
  core does not depend on `@cloudflare/workers-types`) and `cloudflareKvStore(namespace): KeyValueStore`. It maps
  `set` to `put` with `expirationTtl` raised to at least `60`, the Cloudflare minimum. A file of its own, so findings
  4 and 5 own `src/services/store-adapters.ts`.
- `src/worker.ts` (new): `createWorkerApp(env)` and the default `{ fetch(request, env, ctx) }` export. A
  `WATAHUB_KV` binding that is not a KV namespace (for example a plain var) counts as missing and is logged.
- `src/deps.ts`: `createDefaultDeps` remembers the line store it created in a module-private `WeakSet`.
  `isDefaultLineStore(store)` is internal. No signature changes.
- `src/routes/onboarding.ts`: the `connect` check above. Runtime from Hono's `getRuntimeKey()` (`workerd`).
- `src/index.ts`: export `cloudflareKvStore` and the `KvNamespaceLike` type. `app` and the default export stay:
  `src/node.ts` and library users import them.
- `wrangler.jsonc`: `main` and the commented `kv_namespaces` block, per D1.

### Impact on the EE contract

- New exports `cloudflareKvStore` and `KvNamespaceLike`. Additive.
- `connect` answers `503` on `workerd` only when the line store is the core's default. EE always passes its own
  `lineStore`, so EE is not affected.
- No `GatewayDeps` or `LineStore` change.

### Tests

- `tests/worker.test.ts` (new), with a `Map`-backed fake namespace:
  - `connect` through the Worker entry writes the line to KV, and a second app built from the same namespace (another
    isolate) sends with the stored token.
  - Without `WATAHUB_KV`, on `workerd` (stubbed `navigator.userAgent`), `connect` answers `503`, Meta is never
    called, and the error names `WATAHUB_KV`.
  - A `WATAHUB_KV` of the wrong shape counts as missing and is logged.
  - The app is built once per isolate.
- `cloudflareKvStore`: TTL below `60` is raised to `60`; no TTL means no expiration; `get` and `delete` pass through.
- Also in `tests/worker.test.ts` (finding 4 owns `tests/onboarding.test.ts`): on `workerd`, a `MemoryLineStore`
  passed to `createApp` still connects; on Node the default store still connects.

### Docs

- `README.md`: only the warning under "Use it as a library". The env note under "Quick start" belongs to finding 2.
- `docs/DEPLOYMENT.md`: §1 entry is `src/worker.ts`; §2 gains the KV namespace step and drops the "you need
  `META_SYSTEM_USER_TOKEN`" caveat; the checklist.
- `docs/MULTI_TENANCY_AND_EXTENSIONS.md`: only the "Cloudflare Workers with KV" section. It uses `cloudflareKvStore`
  and says `src/worker.ts` already does this.
- `docs/GETTING_STARTED.md` §8 and `docs/API_REFERENCE.md` (`connect` can answer `503` on Workers).

### Manual steps (owner)

```bash
pnpm exec wrangler kv namespace create WATAHUB_KV
```

Put the printed `id` in the `kv_namespaces` block of `wrangler.jsonc`, uncomment it, and deploy on the owner's
instruction. Nothing in this plan creates Cloudflare resources or deploys.

### Done when

The Worker entry stores line tokens in KV when bound; `connect` cannot report a success that does not hold on
Workers; tests above pass; docs describe the new entry and the manual step.

## Finding 2. Workers does not validate three variables per request

**In progress in a separate branch.** No implementation steps here.

- `src/utils/env.ts:123-129`: Workers checks only the `FormattedEnvVar` variables per request.
- Missing: `SUBSCRIBER_WEBHOOK_URL` (the `https` rule), `SUBSCRIBER_WEBHOOK_SECRET` (32+) and
  `META_WEBHOOK_VERIFY_TOKEN` (16+, not a placeholder).
- `README.md:117-120` says each route validates what it reads.

Rebase note: findings 1 and 3 touch `src/routes/webhook.ts` only in the `sync` failure log and the `async`
give-up log (lines `179-232` today), never the env block at the top of the handlers.

## Finding 3. `sync` mode against AI agents

### Problem

- `SYNC_DELIVERY_POLICY` is one attempt with a 3 s timeout (`src/services/delivery.ts:30-35`).
- An agent that calls an LLM before answering takes longer than 3 s. The gateway answers `503`
  (`src/routes/webhook.ts:218-231`), Meta retries, and the agent gets the same event several times.
- The product says "Deploy your agents on your line". The only guidance is "Use `sync` unless your backend cannot
  answer within 3 seconds" (`docs/WEBHOOKS_AND_EVENTS.md:60`).
- The failure log says only "Delivery to subscriber failed ... after 1 attempts" (`src/routes/webhook.ts:219-221`).
  The attempt log carries `TimeoutError` (`src/services/delivery.ts:107-110`) but names no fix.
- `async` drops the event after 3 attempts; only the log keeps it (`src/routes/webhook.ts:179-195`,
  `src/services/delivery.ts:117-121`). `README.md:191` says so in one line.

### Options

| Option | For | Against |
| :--- | :--- | :--- |
| A. Default to `async` | Meta gets `200` at once | Gives up after 3 attempts in about 18 s: a slow agent loses events instead of getting duplicates |
| B. Raise the `sync` timeout (for example to 10 s) | Fewer retries for slow agents | Holds Meta's request open, against Meta's latency guidance quoted at `src/services/delivery.ts:26-28`; an LLM can still exceed any fixed number |
| C. Keep `sync` and 3 s; document "answer 2xx at once, work in the background, dedupe"; log the fix | Keeps Meta's 7-day retries for real failures; fixes the cause, which is the agent doing slow work inside the webhook | Agents must follow the pattern |

### Decision (recommended)

C. This is D3.

The pattern, as the docs will state it:

1. Verify `x-watahub-signature` over the raw body.
2. Drop the event if `x-watahub-delivery-id` or the event's `message.id` (`wamid`) was already seen. The second
   check catches the same message inside a different Meta body.
3. Record it, hand the work to a queue or `waitUntil`, and answer `200` at once.
4. Call the LLM and reply with `POST /v1/messages`.

### Changes by file

- `src/services/delivery.ts`: `DeliveryResult.timedOut?: boolean`, `true` when the last attempt ended on the policy
  timeout (`TimeoutError`).
- `src/routes/webhook.ts`, `sync` failure branch only: when `timedOut`, the log line says the subscriber did not
  answer within `3000` ms in `sync` mode, and names the fix (answer 2xx at once, work in the background) with the
  docs anchor. The `503` stays.
- `src/routes/webhook.ts`, `async` branch only: when a delivery fails for good (not a final `4xx`), one log line
  says the event is only in this log because `async` does not ask Meta to retry.

### Impact on the EE contract

`DeliveryResult` gains the optional `timedOut`. Additive. No other change.

### Tests

- `tests/delivery.test.ts`: `timedOut` is `true` after a `TimeoutError`, absent after a network error or an HTTP
  status.
- `tests/sync-deadline.test.ts`: a `sync` timeout still answers `503` and the error log names the fix and the docs
  anchor; a `5xx` keeps today's line.
- `tests/delivery.test.ts` or `tests/routes-contract.test.ts`: `async` give-up logs the "only in this log" line; a
  final `4xx` does not.

### Docs

- `docs/WEBHOOKS_AND_EVENTS.md`: new section "Answer fast, work in the background" with a Workers example
  (`ctx.waitUntil`) and a Node note (a queue; a promise left running is lost on restart). Replace line 60. State
  plainly that `async` is not durable.
- `README.md` "Webhook delivery": one paragraph pointing to the pattern.
- `docs/GETTING_STARTED.md` §7: one sentence pointing to the pattern.

### Done when

A slow subscriber in `sync` mode produces a log line that names the fix; the docs show the pattern with an example;
`async`'s loss is stated in the docs and in the log.

## Finding 4. Gaps in token custody

### Problem

- `GET /v1/templates` (`src/routes/templates.ts:33`) and `POST /v1/onboarding/subscribe`
  (`src/routes/onboarding.ts:111`) call `metaClientFor` without a line, so only `X-Meta-Access-Token` or
  `META_SYSTEM_USER_TOKEN` work.
- The proxy's `GET /v24.0/:mediaId` takes a phone id only from `POST` paths (`src/routes/proxy.ts:31-36`), so it
  never uses a stored token. `/v1/media` accepts `X-Phone-Number-Id` / `phone_number_id` since `61f1005` (#70,
  `src/routes/media.ts:21-23`).
- The tests pin this on purpose: `tests/onboarding.test.ts:356-358` (`SYS_FOR_MEDIA_GET`) and
  `tests/onboarding.test.ts:362-380`.
- With only the four values `PRODUCT.md:41-45` promises ("Token custody"), `GET /v1/templates` answers `500`.
- `StoredLine` already keeps `wabaId` (`src/deps.ts:11-15`).

### Options

| Option | For | Against |
| :--- | :--- | :--- |
| A. Required `LineStore.findByWaba` | Every store answers | Breaks EE's line store at compile time |
| B. Optional `LineStore.findByWaba?`, implemented by both core stores | Additive; EE keeps today's behavior until it implements it | WABA lookups do nothing on stores without it |
| C. Templates take a phone id instead of a WABA | No port change | Changes the route's shape; subscribe has no phone id |

### Decision (recommended)

B, and the proxy media GET accepts a line the way `/v1/media` does.

Precedence is unchanged: header, then the stored line, then `META_SYSTEM_USER_TOKEN`. For WABA routes, "the stored
line" is the line last connected for that WABA. The Embedded Signup business token covers the WABA the customer
granted, so any of its lines works for WABA calls.

### Changes by file

- `src/deps.ts`: `LineStore.findByWaba?(wabaId)`. `MemoryLineStore` keeps a `wabaId` to `phoneNumberId` index;
  the last line put for a WABA wins.
- `src/services/store-adapters.ts`: `DistributedLineStore.put` also writes `<prefix>waba:<wabaId>` holding the phone
  number ID: a pointer, not a second copy of the token. `findByWaba` reads the pointer, then the line, and treats a
  line that now belongs to another WABA as a miss.
- `src/http/auth.ts`: `MetaTokenSource.wabaId?`. Header, then line by phone, then line by WABA (only without a phone
  id and when the store has `findByWaba`), then the system token.
- `src/http/meta.ts`: `metaClientFor` takes the WABA in its options; the missing-token message for WABA routes names
  `connect`.
- `src/routes/templates.ts`, `src/routes/onboarding.ts` (`subscribe`): pass the WABA.
- `src/routes/proxy.ts`: `GET /v24.0/:mediaId` reads the line from `X-Phone-Number-Id` or `phone_number_id` (header
  wins), used for the lookup only when numeric. A non-numeric value is still forwarded to Graph as today. `POST`
  paths unchanged.

### Impact on the EE contract

- `LineStore` gains the optional `findByWaba?`. Additive: EE's store keeps working and WABA routes behave as today
  there until EE implements it.
- `resolveMetaAccessToken`'s source gains the optional `wabaId`. Without it, behavior is unchanged.
- `DistributedLineStore.put` writes one more key per line.
- Behavior: with a store that has `findByWaba`, `GET /v1/templates` and `POST /v1/onboarding/subscribe` use the
  WABA's stored token before `META_SYSTEM_USER_TOKEN`, and the proxy media GET uses a named line's token.

### Tests

- `tests/onboarding.test.ts:362-380` is changed on purpose: templates and subscribe now use the WABA's line token.
  The `SYS_FOR_MEDIA_GET` assertion (`:356-358`) stays: no phone id named, so the system token.
- New: proxy media GET with `X-Phone-Number-Id` and with `?phone_number_id=` uses the line token; the header token
  still wins; a non-numeric value is not looked up; a store without `findByWaba` falls through to the system token
  (EE's shape).
- `MemoryLineStore` and `DistributedLineStore`: last line wins; a pointer to a line moved to another WABA is a miss;
  a malformed pointer or line is a miss.

### Docs

- `README.md`, "Meta token per call".
- `docs/API_REFERENCE.md` §1.3 (line 41 lists the three routes that do not use the store), templates, subscribe and
  the proxy table.
- `docs/MULTI_TENANCY_AND_EXTENSIONS.md`: the "Line tokens" subsection describes `findByWaba?` and the second key.
  The adapter table belongs to finding 5.

### Done when

With only the four custody values plus one `connect`, `GET /v1/templates`, `POST /v1/onboarding/subscribe` and the
proxy media GET (with a line named) work without `META_SYSTEM_USER_TOKEN`.

## Finding 5. `Distributed*` adapters on Cloudflare KV

### Problem

- `DistributedRateLimitStore.hit` writes `ttlSeconds` between 1 and 60 (`src/services/store-adapters.ts:83-84`).
  Cloudflare KV rejects `expirationTtl` below 60, so a direct KV adapter fails near the end of each window. The
  docs work around it inside the snippet (`docs/MULTI_TENANCY_AND_EXTENSIONS.md:120-127`); the adapter does not.
- Rate limit `hit` (`src/services/store-adapters.ts:65-85`) and replay `remember` (`:29-35`) read, then write. Not
  atomic: two concurrent calls can both pass.

### Options

| Option | For | Against |
| :--- | :--- | :--- |
| A. Clamp only in the KV adapter | One place | Other backends with a floor (or user adapters) still break |
| B. Never ask for less than 60 s in `DistributedRateLimitStore`; `resetAt` in the value keeps deciding the window | Works on every backend | A key outlives its window by up to 60 s; harmless, `blockedFor` and `hit` already check `resetAt` |
| C. Atomic counters in the core | Exact limits | Needs a backend-specific primitive (`INCR`, a Durable Object) the `KeyValueStore` contract does not have |

### Decision (recommended)

B, plus the clamp in `cloudflareKvStore` from finding 1. Document that both adapters are approximate and recommend an
atomic counter (a Durable Object or Redis `INCR`) behind a custom `RateLimitStore` for exact limits.

### Changes by file

- `src/services/store-adapters.ts`: `MIN_KEY_VALUE_TTL_SECONDS = 60`; `hit` writes
  `max(60, ceil(remaining window))`; doc comments on both adapters state read-then-write and eventual consistency.
- `KeyValueStore` doc comment: the gateway never asks for a TTL below 60 s.

### Impact on the EE contract

Behavior only: rate-limit keys written by `DistributedRateLimitStore` live at least 60 s. No type change.

### Tests

- `tests/rate-limit.test.ts` (or `tests/seams.test.ts`, wherever the adapter is tested today): the TTL is never
  below `60`, including a call one second before the window ends; a 10 s window still resets after 10 s although the
  key lives 60 s.

### Docs

- `docs/MULTI_TENANCY_AND_EXTENSIONS.md`: only the adapter table under "Shared state" (TTL at least 60 s;
  approximate; atomic counter for exact limits), including the `DistributedLineStore` row's mention of the second
  key from finding 4.

### Done when

`DistributedRateLimitStore` works on a store with a 60 s floor; the docs state the semantics.

## Later (out of scope)

- Durable Object stores for exact replay and rate limits on Workers (finding 1, option E).
- Host allowlist for media downloads (`src/routes/media.ts:57`).
- `GET /v24.0/\d+` reads any Graph node the token can see, not only media.
- `fbtrace_id` in proxy error logs.
- The `POST oauth/access_token` exchange has not been tested against Meta.

## Parallel work

One session per finding, each in its own git worktree and branch, cut from the commit that adds this plan. Each
session makes one commit on its own branch, runs `pnpm check` green, and does not push or open a PR.

| Finding | Commit |
| :--- | :--- |
| 1 | `feat(workers): store line tokens in KV and fail closed on connect` |
| 3 | `feat(webhook): name the fix when sync delivery times out` |
| 4 | `feat(tokens): use stored line tokens for WABA routes and proxy media` |
| 5 | `fix(stores): never ask a key-value store for a TTL below 60 s` |

File ownership, so the merges stay clean. A session touches only its own files and sections. A file listed for two
findings is split by section, and each stays inside its section.

| File | Owner |
| :--- | :--- |
| `src/worker.ts`, `src/services/cloudflare-kv.ts`, `tests/worker.test.ts`, `src/index.ts`, `wrangler.jsonc`, `docs/DEPLOYMENT.md` | 1 |
| `src/deps.ts` | 1: `createDefaultDeps` and the default-store marker only. 4: `LineStore` and `MemoryLineStore` only |
| `src/routes/onboarding.ts` | 1: the `connect` handler and the imports it needs. 4: the `subscribe` handler only |
| `src/services/delivery.ts`, `src/routes/webhook.ts` (outside the env block), `tests/delivery.test.ts`, `tests/sync-deadline.test.ts`, `docs/WEBHOOKS_AND_EVENTS.md` | 3 |
| `src/http/auth.ts`, `src/http/meta.ts`, `src/routes/templates.ts`, `src/routes/proxy.ts`, `tests/onboarding.test.ts` | 4 |
| `src/services/store-adapters.ts` | 4: `DistributedLineStore` and `parseStoredLine`. 5: everything else (`KeyValueStore`, `DistributedReplayStore`, `DistributedRateLimitStore`) |
| `README.md` | 1: the warning under "Use it as a library". 3: "Webhook delivery". 4: "Meta token per call" |
| `docs/GETTING_STARTED.md` | 1: §8. 3: §7 |
| `docs/API_REFERENCE.md` | 1: the `connect` section. 4: §1.3, templates, subscribe and the proxy table |
| `docs/MULTI_TENANCY_AND_EXTENSIONS.md` | 1: "Cloudflare Workers with KV". 4: "Line tokens". 5: the adapter table |
| `tests/seams.test.ts` | Prefer new test files. If an existing case must change: 4 owns the `DistributedLineStore` cases, 5 the `DistributedReplayStore` and `DistributedRateLimitStore` cases |
| New test files | Whoever creates them, named after the finding |
| This plan | The coordinating session only |

Merge order into `claude/core-hardening-5dec65`: 1, 3, 4, 5, then `pnpm check` on the result. Merging waits for the
owner's word. No push, no PR, no deploy, no Cloudflare resources and no Meta writes without the owner's OK.
