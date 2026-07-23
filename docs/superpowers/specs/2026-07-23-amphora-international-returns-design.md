# Switch international returns & exchanges to Amphora

**Date:** 2026-07-23
**Status:** Approved design — pending implementation plan
**Author:** Santiago Gericke (with Claude)

## Context & driver

International returns were built twice:
- **Amphora** (`actions/amphoraReturn.ts`) — courier **collection** from the customer's address, no label to print, customs handled by Amphora. Built, deployed, gated **off** (`AMPHORA_INTL_RETURNS_ENABLED`). Never live-tested end-to-end.
- **Sendcloud** (`actions/sendcloudReturn.ts` + `/api/return-label/[parcelId]` proxy) — pre-paid Correos drop-off label, **EU-only** (excludes non-EU for customs/RGR reasons). Built, live-tested end-to-end, currently **live** (`SENDCLOUD_INTL_RETURNS_ENABLED=true`).

Sendcloud was chosen when Amphora looked ~41% over market. **The merchant has since negotiated better pricing with Amphora** for international, and Amphora covers **all** destinations (EU **and** non-EU) **including customs** — which Sendcloud's EU-only drop-off cannot. Decision: route **all** international returns **and** exchanges through Amphora; retire Sendcloud to a dormant, instantly re-enableable fallback.

## Goals

- All non-Spain returns **and** exchanges route to Amphora collection.
- Spain unchanged (Correos national label).
- Sendcloud retained as dormant fallback (flag off, code intact).
- Validate Amphora end-to-end before any customer exposure.

## Non-goals

- No change to the Spain/Correos flow.
- No removal of Sendcloud code this cycle.
- No change to the financial refund/gift-card/exchange-order admin step (`actions/refund.ts`).

## Current-state facts (verified)

- **Routing already flag-driven** — no routing code change needed:
  - `actions/return.ts` `createReturnShipment` and `app/api/webhooks/stripe/route.ts` both compute:
    `useSendcloud = euIso2ForReturn(country) && SENDCLOUD_INTL_RETURNS_ENABLED==="true"`;
    `useAmphora = !useSendcloud && isInternationalOrder(country) && AMPHORA_INTL_RETURNS_ENABLED==="true"`;
    else → Correos.
  - With Sendcloud off + Amphora on, **every** non-Spain order (EU and non-EU) → Amphora.
- `isInternationalOrder(country)` (`amphoraReturn.ts:20`) = any country not in `{spain, españa, espana, es, esp}`.
- **Exchanges** use the same physical path: free exchange → `return.ts` `returnFunction`; paid exchange → Stripe webhook. Both call the same routing. The replacement order is created later in the admin step (`refund.ts` → `createOrder`), which is untouched.
- **Portal entry gate** (`actions/order.ts` `validateOrderDetails`) currently allows: Spain, OR an EU lane when the *Sendcloud* flag is on. This is the only code that must change.
- `createInternationalReturn` sends Amphora only `{ sku, quantity }` per item (+ order id, external_id, email); it has an idempotency guard on `external_id`, persists `locator/carrier/carrierUrl`, and sends a "courier will collect" Postmark email.

## Change surface

1. **Portal gate** (`actions/order.ts` `validateOrderDetails`): accept international orders when `AMPHORA_INTL_RETURNS_ENABLED==="true"` (via `isInternationalOrder`). Keep the existing Spain rule and the Sendcloud-EU condition as a dormant `OR` so Sendcloud stays instantly re-enableable. Non-flagged/unhandled cases keep the "contact hello@…" message.
2. **Env flags (Vercel prod):** `AMPHORA_INTL_RETURNS_ENABLED=true`, `SENDCLOUD_INTL_RETURNS_ENABLED=false`.
3. **Nothing else** — routing, exchange path, Amphora module, Sendcloud code all unchanged.

## Phased plan (gated, each with verifiable success criteria)

### Phase 1 — Amphora readiness validation (de-risk first)
Run a controlled `createInternationalReturn` against fake orders via a throwaway harness (same pattern as the Sendcloud test): **one EU lane + one non-EU (customs) lane**.
- **Success:** collection booked at Amphora, `locator/carrier/carrierUrl` persisted, collection email received; test collections then cancelled in Amphora by the merchant.
- **Must confirm here:**
  - (a) **Customs data** — `createInternationalReturn` sends only SKU+qty; confirm Amphora derives customs (HS/value/origin) from the SKU catalog on their side for non-EU, or identify what extra data the create call must include.
  - (b) **SKU coverage** — SKU-less variants are silently dropped; confirm all returnable variants carry SKUs.
  - (c) **Cancel path** — how a booked collection is cancelled (Amphora UI/API) so tests leave nothing physical.

### Phase 2 — Gate change (safe deploy)
Update `validateOrderDetails`; typecheck; commit; deploy. Amphora flag still off in prod ⇒ behavior unchanged.
- **Success:** deployed, `tsc` clean, no customer-facing change yet.

### Phase 3 — Full tool e2e
Create a fake **fulfilled** international Shopify order (reuse the setup already in progress), run it through the real portal with the Amphora flag on (preview or a brief prod window):
portal accepts → `returnFunction` → `createInternationalReturn` → collection booked → email received → Shopify return created; then clean up (cancel collection, close Shopify return, delete rows).
- **Success:** a real international order completes the whole flow via Amphora.

### Phase 4 — Flip flags in prod
Set `AMPHORA_INTL_RETURNS_ENABLED=true`, `SENDCLOUD_INTL_RETURNS_ENABLED=false`; redeploy.
- **Success:** a live international return/exchange routes to Amphora; first real one watched.

### Phase 5 — Monitor & document
Watch the first real collections, update `docs/` + memory, leave Sendcloud dormant.
- **Success:** ≥1 real Amphora return and ≥1 real exchange complete cleanly.

## Risks & mitigations

- **Customs completeness (non-EU):** the create call sends no customs values — Phase 1 (a) must confirm Amphora derives them; otherwise extend the payload before Phase 4.
- **Amphora failure for a given order** (country not serviceable, SKU unresolved, API error): current behavior returns 501 → `returnFunction`/webhook revert the DB order and the customer sees failure. Mitigation: log loudly for manual follow-up; consider a "contact us" graceful fallback in a later cycle.
- **Un-tested integration:** Phases 1 and 3 exist specifically to validate before flipping.

## Rollback

Flip flags back: `SENDCLOUD_INTL_RETURNS_ENABLED=true`, `AMPHORA_INTL_RETURNS_ENABLED=false`, redeploy. Gate keeps the dormant Sendcloud-EU `OR`, so EU returns resume via Sendcloud immediately; non-EU falls back to "contact us".
