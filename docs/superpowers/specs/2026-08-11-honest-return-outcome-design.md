# Telling the customer what actually happened

**Status:** approved design, not yet implemented
**Date:** 2026-08-11

## The problem

`returnFunction` (`actions/return.ts`) ends with an unconditional
`redirect("/success")`. It runs whether the return succeeded, failed, or threw:

```ts
const statusLabel = await createReturnShipment(id);
if (statusLabel !== 200) {
  await updateFinalOrder(id, true, isCredit);        // revert
  console.error("Failed to create shipping label");  // console only
}
} catch (error) { /* revert */ }
redirect(`/success`);                                // always
```

The only record of a failure is a server log. **The customer is shown the
success page even when nothing was created.**

Two live cases:

- **Zinsi van der Sangen (#310185, NL), 5 August.** `returnCreate` threw on the
  missing `returnReasonNote`, the catch reverted, and she was sent to
  `/success`. She wrote in asking *"Did I do something wrong?"* — she had been
  told it worked.
- **Carlos Martinez Garcia (#311109, ES), 6 August.** Same symptom on the
  domestic path, after paying an 8 EUR fee.

A second, smaller defect exposed the first: the submit takes ~8 seconds
(Shopify `returnCreate` → Amphora booking → carrier read-back) and
`AsyncButton` shows no pending state, so the customer clicks again. On
2026-08-10 that produced a second submit which every guard correctly refused —
and the customer's reward was a page that still said success, because the
redirect is unconditional either way.

## What we are building

1. `/success` reports what actually happened, verified against the database.
2. The submit button shows a pending state so the double-click stops happening.

## Why verify rather than pass a flag

A query parameter (`/success?state=failed`) would only ever know about the free
path. The paid path leaves for Stripe Checkout and returns by a top-level
navigation that carries no such parameter — which is precisely Carlos's case.

The portal session cookie makes verification possible: it holds the order id,
is signed, lasts 2 hours, and is deliberately `sameSite: "lax"` so it survives
the Stripe round-trip (`lib/orderAccess.ts`). So `/success` can load the order
and look.

Verifying also dissolves the duplicate-submit question. A second submit finds a
return that genuinely exists, so it renders success with no special case.

## Architecture

```
Stripe return ─┐
free path ─────┴──▶ /success (server component)
                      1. read signed session cookie  → order id
                      2. getOrderById(id)            → order + products
                      3. returnOutcome(order)        → confirmed | missing | unknown
                      4. render the matching state
```

`returnFunction` is unchanged. That is the point: the paid path is fixed
without touching the Stripe webhook.

### New: `lib/returnOutcome.ts`

Pure — no database, no cookies, no network. Takes an order-shaped object,
returns the outcome plus whatever tracking detail is available. All judgement
lives here so it is unit-testable, matching `lib/amphoraReturnMatch.ts` and
`lib/amphoraWebhook.ts`.

### Changed: `lib/orderAccess.ts`

Add `currentOrderId(): string | null` beside the existing `hasOrderAccess(id)`.
The crypto already exists in `lib/orderSession.ts`; this answers "which order is
this session for" rather than "is it this one". Server-only, like the rest of
the module.

### Changed: `app/success/page.tsx`

From a static page to one that reads the session and branches.

### Changed: `app/[id]/components/buttons/asyncButton.tsx`

Pending state via `useTransition`.

## What counts as a return existing

`order.products.some((p) => p.confirmed === true)` — the same signal
`getReturns` and the cron's ownership rule use, and the one the revert clears.

**Deliberately not `locator != null`.** An international return whose carrier
has not been assigned yet has a null locator and is entirely real. That test
would have called seven live returns failures during the August incident.

| Outcome | Condition | Renders |
|---|---|---|
| `confirmed` | a confirmed line item exists | Confirmation, enriched with carrier + tracking when present |
| `missing` | session valid, order loads, no confirmed line | Failure state + retry link |
| `unknown` | no valid session, or the order will not load | Today's generic copy, unchanged |

`unknown` degrades to the current message on purpose. The session TTL is 2
hours and a slow Stripe checkout can exceed it; a customer whose return is fine
must not be alarmed by an expired cookie. **Never claim a failure we cannot
prove.**

## Copy

- **confirmed** — existing `success.title` / `success.body`. When `locator` is
  present, add a tracking block: carrier name, tracking number, and a link only
  when `carrierUrl` exists (international has one, Correos gives a bare number).
- **missing** — existing `error.title` / `error.body`, which already tells the
  customer to retry and to email us with their order number, plus a retry link
  to `/{orderId}`.
- **unknown** — unchanged.

New keys in both locales: `success.trackingLabel`, `success.carrierLabel`,
`common.processing`. Everything else reuses existing dictionary entries.

## Pending state

`AsyncButton` wraps the call in `startTransition`. While pending the button is
`disabled` and `aria-busy`, and its label swaps to `common.processing` with a
spinner. Because `returnFunction` ends in a redirect, `isPending` stays true
through the navigation, so the button never flickers back to clickable
mid-flight.

## Testing

- `tests/returnOutcome.test.ts` — full coverage of the pure predicate, with an
  explicit case pinning that **a confirmed line with a null locator is
  `confirmed`**, not a failure.
- `tests/successPage.test.ts` — call `SuccessPage()` directly with `cookies()`
  and `getOrderById` mocked, asserting which branch the returned element tree
  took. `tests/amphoraSyncRoute.test.ts` already mocks modules this way.
- **No automated test for the button's pending state.** `vitest.config.mts`
  sets `environment: "node"` and there is no jsdom; adding one for a single
  button is not worth the dependency. Verified manually.

## Known limitation

This reports what our database says. A return booked at Amphora whose write to
our database failed will be reported to the customer as a failure while a
courier is on the way — the orphan case. It is rarer than what this fixes, and
`/api/cron/amphora-sync` is what closes it, once `CRON_SECRET` is set in
production.

## Out of scope

- Making the Stripe webhook notify the customer on failure. The success page
  covers the customer who is looking at the screen; a customer who closed the
  tab is a separate problem.
- Changing `returnFunction`'s control flow or its revert behaviour.
