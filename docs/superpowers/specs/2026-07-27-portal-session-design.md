# Portal session for `/[id]`

**Date:** 2026-07-27
**Status:** Approved design — pending implementation plan
**Author:** Santiago Gericke (with Claude)

## Context & driver

`actions/order.ts` `getOrder` proves ownership properly — it requires an order
number **and** a matching `contact_email` — and then throws that proof away. It
redirects to `/{order.id}` and issues nothing: no cookie, no token, no session.
From that point on the URL *is* the credential, and every server action behind it
takes the order id from the client and trusts it.

`orders.id` is the raw Shopify order id (`formatOrderId` = `String(order.id)`), so
it is numeric and sequential. It is enumerable.

This produces two distinct problems from one root cause:

1. **Information disclosure.** `/[id]` renders the customer's name, street
   address, and phone (`secondWindowForm.tsx`). Guessing an id exposes PII.
2. **Unauthorised writes.** `updateData` rewrites the shipping address — which
   redirects where the return label is sent. `updateOrder`, `anularOrder` and
   `returnFunction` alter or submit the return.

Two related holes were found while scoping this work and fixed separately, because
each was categorically worse than the class above:

- **PR #3** — `anularOrder` was scoped by `variant_id` alone, so one call cleared
  the in-progress selection of *every customer* who had bought that product.
  Reachable with public storefront data, no order id required.
- **PR #4** — `validateReturn` mints gift cards and issues refunds with no
  authentication, and its `product`/`order` arguments are caller-supplied `any`.
  One anonymous call with an inflated `price` minted a card of arbitrary value.

Those are closed. This spec addresses what remains: the customer-facing class.

## Goals

- A visitor to `/[id]` must have proven ownership of that order.
- Every customer-facing write must verify the same, so a client-supplied order id
  becomes unusable on its own.
- No schema change and no migration.
- A customer whose session lapses reaches the lookup form, not a dead end.

## Non-goals

- No change to the ownership proof itself. Order number + contact email stays.
- **No rate limiting on the lookup.** Guessing an order number *and* its email
  remains possible. Real, out of scope, noted under Follow-ups.
- No account system, no password, no email round-trip.
- No change to admin authentication (`middleware.ts` + `lib/requireAdmin.ts`).
- No change to return routing or to the Stripe webhook's own authentication.

## Current-state facts (verified)

- `getOrder` (`actions/order.ts:26`) validates the email against
  `order.contact_email`, then `redirect(/${order.id})`. Nothing is issued.
- `orders.id` is a numeric Shopify order id — sequential, enumerable.
- `/[id]` renders `shippingName`, `shippingAddress1`, `shippingPhone`.
- **No email or external link points at `/{id}`.** The transactional emails link
  to `/api/return-label/[parcelId]` and to carrier tracking. The URL scheme is
  therefore unconstrained, and a session cookie cannot break an emailed link.
- `NEXTAUTH_SECRET` already exists (`lib/auth.ts:67`). No new env var.
- `middleware.ts` matches only `/dashboard/:path*` and `/login`.
- Server actions are independently addressable HTTP endpoints and are **not**
  covered by route middleware. This is the mistake that produced PR #4.

### The constraint that shapes the whole design

`updateFinalOrder`, `createShippingLabel`, `createInternationalReturn` and
`createSendcloudReturn` are each called from **two** callers:

| Caller | Has a cookie? | Authenticated by |
|---|---|---|
| `returnFunction` (`actions/return.ts`) | yes | this design |
| Stripe webhook (`app/api/webhooks/stripe/route.ts`) | **no** | Stripe signature verification |

The webhook is an inbound request from Stripe, not from the customer's browser.
**Gating those four functions would break every paid return.** The gate belongs on
the customer entry points, never on the shared internals.

## Decisions

| Question | Decision |
|---|---|
| Mechanism | Signed, stateless cookie |
| Signing key | Existing `NEXTAUTH_SECRET` |
| Lifetime | **2 hours**, absolute from issue (not sliding) |
| Scope | One order per session; a new lookup replaces it |
| Denied UX | Redirect to `/` with a message; never confirm the order exists |
| Storage | None — no table, no migration |

**On 2 hours:** long enough for a return including a detour to Stripe and back,
plus interruption; short enough to bound exposure on a shared browser.
Re-verifying costs the customer an order number and an email they already have.

**On absolute rather than sliding expiry:** simpler to reason about and to test,
and it caps total exposure rather than extending it with activity.

## Design

### 1. `lib/orderSession.ts` (new)

Pure crypto and encoding. No `db`, no `next/headers` — so it is unit-testable
without a database or a request.

```ts
export function signOrderSession(orderId: string, expiresAt: number): string;
export function verifyOrderSession(
  cookieValue: string | undefined,
  orderId: string,
  now: number,
): boolean;
export const ORDER_SESSION_COOKIE = "return_session";
export const ORDER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
```

Payload is `{ orderId, exp }`, base64url-encoded, with an HMAC-SHA256 appended
over that exact encoded string. Verification must:

- reject a missing, malformed or truncated value;
- compare the signature with `crypto.timingSafeEqual`, after a length check —
  `timingSafeEqual` throws on a length mismatch. The repo already does this
  correctly in `app/api/return-label/[parcelId]/route.ts`, which is the reference;
- verify the signature **before** trusting any field in the payload;
- reject when `exp <= now`;
- reject when the payload's `orderId` is not the one being requested.

`now` is a parameter rather than a call to `Date.now()` so expiry is directly
testable.

### 2. `lib/orderAccess.ts` (new, server-only)

The thin `next/headers` layer, kept separate so `lib/orderSession.ts` stays pure.

```ts
export async function issueOrderAccess(orderId: string): Promise<void>;
export async function hasOrderAccess(orderId: string): Promise<boolean>;
```

`issueOrderAccess` sets the cookie: `httpOnly`, `sameSite: "lax"`,
`secure: process.env.NODE_ENV === "production"`, `path: "/"`,
`maxAge: ORDER_SESSION_TTL_MS / 1000`.

`sameSite: "lax"` rather than `"strict"` deliberately: the customer returns from
Stripe Checkout via a top-level cross-site navigation, and `"strict"` would
withhold the cookie on that hop.

### 3. Issue the session

In `actions/order.ts` `getOrder`, immediately before **each** `redirect`
(there are two — the order-exists path and the newly-saved path), after
`validateOrderDetails` has passed:

```ts
await issueOrderAccess(order.id);
redirect(`/${order.id}`);
```

`redirect()` throws by design, so the call must precede it.

### 4. Enforce on the page

`app/[id]/page.tsx`, before any data is fetched or rendered:

```ts
if (!(await hasOrderAccess(params.id))) redirect("/?session=expired");
```

`app/page.tsx` reads that query parameter and renders a localized message
(`t.lookup.sessionExpired`, added to both dictionaries). The message must not
reveal whether the id names a real order — the same text is shown whether the
cookie is absent, expired, or names a different order.

### 5. Enforce on the customer entry points

| Action | Change |
|---|---|
| `returnFunction(id, ...)` | verify `id`; return early if invalid |
| `updateData(prevState, formData)` | verify `formData.get("id")`; return `prevState` |
| `updateOrder(formData)` | verify `formData.get("id")`; return early |
| `anularOrder(productOrderId)` | **gains an `orderId` parameter** — see below |

Rejection is silent. The caller already ignores these results, and an
unauthenticated caller should learn nothing.

### 6. `anularOrder` gains an order id

PR #3 changed it to take a `productsorder` row primary key, which leaves nothing
to check a session against. It becomes:

```ts
export async function anularOrder(productOrderId: number, orderId: string)
```

It verifies `orderId`, then scopes the write by **both** columns:

```ts
.where(and(eq(productsOrder.id, productOrderId), eq(productsOrder.orderId, orderId)))
```

Both are already available at the call site (`dialogForm.tsx`). This is strictly
tighter than PR #3: a row id alone no longer suffices even with a valid session
for a different order.

### 7. Explicitly NOT gated

`updateFinalOrder`, `createShippingLabel`, `createInternationalReturn`,
`createSendcloudReturn`. Each gets a comment recording that it is shared with the
signature-verified Stripe webhook, which has no cookie, and that gating it would
break every paid return. Without that comment the omission reads as an oversight
and someone will "fix" it.

## Verification

`lib/orderSession.ts` is pure, so it takes full unit coverage with no database:

- a signed session verifies for its own order id;
- it does **not** verify for a different order id;
- it does not verify one millisecond past `exp`;
- a tampered payload fails (flip a character in the encoded body);
- a tampered signature fails;
- a signature of the wrong length fails rather than throwing — the
  `timingSafeEqual` trap;
- a value with no separator, an empty string, and `undefined` all fail;
- a session signed with a different secret fails;
- the encoded payload is not mistaken for encryption — assert it is readable, so
  nobody later puts something sensitive in it.

Roughly 12 tests. `tsc --noEmit`, `next lint`, and the existing 110 must stay green.

**Cannot be verified here:** no database, no browser. A human must confirm the
whole flow — lookup, walk the return, complete it — still works, and that a
`/[id]` URL opened in a private window redirects to the lookup.

## Risks

- **Gating a shared internal by mistake breaks paid returns.** The largest risk in
  this change, and the reason §7 exists.
- **Cookie lost mid-flow** sends the customer back to the lookup. Acceptable: the
  proof is two fields they already have.
- **A second order in the same browser** replaces the first session, so returning
  to the first order's URL requires another lookup. Rare; acceptable.
- **`redirect()` throws.** Any verification added inside a `try` in
  `returnFunction` must not swallow it. The file already has this hazard flagged.

## Follow-ups (explicitly not this spec)

- **Rate limiting on `getOrder`.** Nothing throttles order-number + email
  guessing. With this spec in place, that lookup becomes the only door — which
  makes throttling it more valuable, not less.
- `app/api/shipping-status` (GET) is unauthenticated. Low severity: a read
  requiring a valid carrier tracking number the customer already holds.
- `validateReturn` still takes `product`/`order` as caller-supplied `any`. PR #4
  closed the anonymous path; an authenticated admin can still pass an arbitrary
  gift-card value. Should take ids and load its own data.
