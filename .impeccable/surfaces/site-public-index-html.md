---
version: 1
slug: "site-public-index-html"
primary_target: "site/public/index.html"
related_targets: ["site/public/es/index.html","site/public/pt/index.html","site/public/404.html"]
---

## Scope

`watahub.dev` home page in English (`/`), Spanish (`/es/`) and Portuguese (`/pt/`), plus the 404 page in the three
languages. Visitor mode: Persuade. Static, no scripts, CSP `'self'`.

## Audience and action

Developers integrating WhatsApp through Meta's Cloud API. Primary action: take the MIT source on GitHub to self-host.
Secondary: create a hosted account on `app.watahub.dev` when they don't want to own a Meta app. Proof: the real API
(connect request, 200 without `accessToken`, send without a Meta token, signed normalized events). Sections: hero,
connect, send, what you never touch, events and webhooks, self-host, hosted account, close.

## Direction contract

THESIS: Every WhatsApp moment sits beside its machine twin: the message and the signed event your webhook receives,
the reply and the `POST /v1/messages` that carries no Meta token. It refuses the split hero with a product screenshot
over a row of feature cards.

OWN-WORLD: The panel's Quiet Console. Zinc neutrals, surface-2 code wells, one teal for actions, outbound bubbles and
the "no Meta token" mark. System UI sans, JetBrains Mono for every machine value, 1 px borders, 6/8/12 px radii,
14 px bubbles, flat, light and dark from the OS.

STORY: In one viewport the visitor sees that Watahub stores the business token and that a send only names a phone
number id. They scroll through connect, send, events, self-host and hosted as message/record pairs, then take the
source on GitHub, or open a hosted account if they won't own a Meta app.

FIRST VIEWPORT: A top bar with the logo, section links, EN · ES · PT and GitHub. The left 5/12 holds the tagline h1
"The hub for your WhatsApp agents", a lede that frames the agents as working for a business, the owner's three steps
as a numbered list, "Source on GitHub" (primary) beside "Getting started", and one link to the hosted account. The
right 7/12 holds an Inbox frame marked "Example data": an inbound bubble paired with its signed delivery, and an
outbound teal bubble (the agent's reply) paired with `POST /v1/messages` and the "No Meta token" badge. The next
section's heading ("Connect your line", step 1) shows above the fold at 1440×800.

FORM: Message and record pairs, number 4 on my ordered list of 7. seed:1620982f57237540. Signature interaction: hover
or focus on a bubble or its record lights the pair and its connector, with CSS `:hover` and `:focus-within` on the pair and no script. Motion:
0.12 s state transitions and one connector draw, cut under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Open

- Tokens and components mirror watahub-ee `public/tokens.css` and `public/components.css` at `a858f6b`; recopy them
  when watahub-ee changes.
- The en and pt tagline and steps are used verbatim, as in the READMEs; they change only when the owner rewords them.
