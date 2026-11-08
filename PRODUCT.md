# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: developers who integrate WhatsApp through Meta's official Cloud API and want to run the gateway themselves.
They arrive at the public site `watahub.dev`, decide whether Watahub fits, and go to the MIT source on GitHub to
self-host it (owner, 2026-11-08).

Secondary: developers who would rather not set up and own a Meta app. They create an account on the hosted panel
`app.watahub.dev` and connect their numbers through the operator's Embedded Signup (owner, 2026-11-08).

## Product Purpose

Watahub is an open-source WhatsApp Cloud API gateway built on Hono. It sits between a developer's systems and Meta's
Cloud API: it connects phone lines through Embedded Signup, sends messages and media, verifies and normalizes Meta's
webhooks, and forwards one signed delivery to the developer's endpoint.

`watahub.dev` is the project's public page. Success is a visitor who understands in one visit that Watahub keeps the
business token for them, and then either takes the source to self-host or opens a hosted account.

## Positioning

Tagline (owner, 2026-11-08, relayed by the coordinating session): "El hub de tus agentes para WhatsApp", in English
"The hub for your WhatsApp agents" and in Portuguese "O hub dos seus agentes para WhatsApp". The en and pt wording is
the coordinating session's translation; it is used verbatim on the site and in the READMEs so every surface says the
same thing, and changes only when the owner rewords it, everywhere at once. It fits the name: Wata + Hub. Three steps: "Conecta tu línea / Despliega tus agentes en tu línea /
¡Listo!" (en "Connect your line / Deploy your agents on your line / That's it."; pt "Conecte sua linha / Implante seus
agentes na sua linha / Pronto!"). Agents are framed as working for a business (support, sales, bookings), never as
general-purpose chat assistants, which Meta's WhatsApp Business terms bar. Truth limits: step 2 is plumbing today (the
agent gets each inbound message as a signed webhook and replies with `POST /v1/messages`; `/mcp` exists only on the
hosted account); no framework templates or one-click deploys exist yet. Coexistence with the WhatsApp Business app,
setup links, 7-day logs and the Inbox are hosted-only. The Inbox lets a person read, reply and assign; it does not
pause the agent, so no surface promises a "take over".

Token custody: the developer pastes four Meta values once (`META_APP_ID`, `META_APP_SECRET`, `META_CONFIGURATION_ID`,
`META_API_VERSION`); `POST /v1/onboarding/connect` exchanges the Embedded Signup code, stores the business token,
subscribes the WABA and registers the phone, and the response never contains the token. Every send names a phone
number id and uses the stored token. On the hosted panel the same custody holds per tenant: the Meta token stays
sealed in the gateway and the tenant holds only a revocable Watahub API key.

No middleman markup: Meta's conversation fees are paid to Meta directly.

## Operating Context

- Two ways to run it: self-hosted (open core, MIT: one operator, one Meta app, one subscriber webhook, one
  `WATAHUB_API_KEY`, N phone lines), or the hosted multi-tenant account at `app.watahub.dev` (Enterprise Edition,
  private repository `watahub-ee`).
- Self-host runtimes: Cloudflare Workers and Node (`pnpm run dev:node`). Bun and other runtimes are not tested (CI targets
  Node 20 and 22), so no surface claims them.
- Docs live in the repository: `docs/GETTING_STARTED.md`, `docs/API_REFERENCE.md`, `docs/WEBHOOKS_AND_EVENTS.md`,
  `docs/ARCHITECTURE.md`, `docs/MULTI_TENANCY_AND_EXTENSIONS.md`, `docs/DEPLOYMENT.md`.
- Sibling surfaces: the account panel `app.watahub.dev` and its hosted connect page (repo `watahub-ee`), and the
  superadmin console `cloud.watahub.dev`, which keeps its own look by the owner's decision.

## Capabilities and Constraints

- Confirmed claims the site may make (owner, 2026-11-08): everything the current site states; what the core README
  documents (no markup on Meta's fees, normalized webhook events, HMAC-SHA256 verification of Meta's webhooks and
  signed deliveries with `x-watahub-signature`, streaming media uploads up to 100 MB, Workers and Node); what the
  hosted panel does (Inbox, signed webhooks per number, 7-day logs, revocable API keys shown once, installable PWA
  with push notifications for new Inbox messages); and that a new hosted account starts with a courtesy credit, with
  no amount stated.
- The site is a static-assets Cloudflare Worker (`site/`, Worker `watahub-site`, custom domain `watahub.dev`) with no
  build step. CSP allows only `'self'` for styles, fonts and images and no scripts at all: no inline styles or
  scripts, no CDNs, self-hosted fonts.
- Languages: English at `/`, Spanish at `/es/`, Portuguese at `/pt/`; each page links to the other two and declares
  `hreflang` (owner, 2026-11-08). With no scripts, there is no automatic language detection.
- Production deploys only from `main` and only on the owner's instruction.
- Version today: core 0.2.0.

## Brand Commitments

- Name: Watahub, by Hub Ventures. Logo mark: the dot, ring and arc in `site/public/favicon.svg` and the panel's
  inline logo.
- The site, the account panel and the hosted connect page read as one product (owner, 2026-11-08).
- Voice: plain, technical, direct. Short declarative sentences; machine values (paths, headers, env names, ids) set
  as code.

## Evidence on Hand

- Real content: the current site copy (`site/public/index.html`), the README, the docs and the API's real request and
  response shapes.
- No customer names, testimonials, usage numbers, benchmarks or prices exist; do not invent them. The courtesy credit
  has no published amount.

## Product Principles

1. Custody first: no surface shows, asks for or implies handing over a Meta token.
2. Prove with the real API: show actual routes, requests and responses instead of adjectives.
3. Open source leads; hosted is the shortcut for those who don't want to own a Meta app.
4. One product across surfaces: the site, panel and connect page share one design and one voice.
