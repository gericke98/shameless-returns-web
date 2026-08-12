# Cancelling a return before the parcel moves

**Status:** approved design, not yet implemented
**Date:** 2026-08-12

## The problem

The portal is one-way. A customer submits a return or an exchange and we create
a Shopify return, book Correos (Spain) or Amphora (international), pre-register
the parcel with Amphora, hold the replacement stock in a draft order, charge
the card and email a label. From that moment there is no way back: there is no
cancel path anywhere in `actions/`, and none in the dashboard either.

A customer who picked the wrong garment, the wrong size, or changed their mind
has one option — email support and wait for a human to unpick five systems by
hand.

They should be able to cancel it themselves and get their money back, **but
only while the reversal is still honest**: before the parcel enters the carrier
network, and before we have settled the return on our side.

## What "cancellable" means

Cancellation is safe exactly while nothing physical or financial has happened
yet. Four signals decide it. Any one of them blocks.

| Signal | Source | Why it blocks |
| --- | --- | --- |
| No line has `confirmed = true` | `productsOrder` | There is no return to cancel. |
| Any line has `refunded = true` | `productsOrder` | An admin already settled it in `validateReturn` — a refund issued, a gift card minted, or the replacement exchange order created. "Already sent." |
| `orders.returnStatus` is past approval | Amphora webhook | `TRAVELLING`, `PROCESSING_WAREHOUSE`, `RECEIVED`, `FINISHED`, `FINISHED_REJECTED`, `EXCEPTION`, `EXCEPTION_WAREHOUSE`. The collection happened. |
| Correos reports movement | `obtainLastStatus` | Phase `admitido`, `en_transito`, `en_reparto`, `entregado` or `incidencia`. The customer deposited the parcel. |

`PENDING`, `APROVED` and a null `returnStatus` are all cancellable. Null is the
normal state for a return no webhook has been seen for yet, and for every
domestic pre-registration.

There is deliberately **no time limit**. Elapsed time is not evidence about a
parcel; tracking is. A customer who cancels on day six with an untouched label
is in exactly the position a customer on day one is.

### The tri-state that makes this work

`obtainLastStatus` currently returns `UNKNOWN_TRACKING` (`sin_informacion`) for
two completely different situations:

1. Correos has no events for this locator yet — the **normal** state of a
   freshly pre-registered, entirely cancellable label.
2. Correos was unreachable, returned an unparseable payload, or the credentials
   failed — we learned nothing.

Treating those the same breaks the feature in whichever direction you pick.
Allow on `sin_informacion` and a Correos outage becomes a machine for refunding
customers whose garments are already in transit. Block on it and the button
never appears for anybody.

So the carrier read grows a reachability signal, kept separate from its
findings:

```
carrierMovement(order) -> "moved" | "not-moved" | "unreadable"
```

- `moved` → blocked.
- `not-moved` → allowed. Covers phase `prerregistrado` and a successful lookup
  that returned no events.
- `unreadable` → **blocked**, with "we can't check on your parcel right now,
  please try again shortly" rather than a refund.

`unreadable` failing closed is a deliberate asymmetry. Wrongly blocking costs a
support email; wrongly allowing costs the refund *and* the garment, and strands
a parcel at Algete against a return that no longer exists.

This is the same rule `lib/trackingStatus.ts` already states — never invent a
status, absence of data is its own state — extended one step: absence of data
and absence of an answer are also not the same thing.

## What cancelling reverses

`actions/cancelReturn.ts`, gated by `hasOrderAccess(id)` exactly as
`returnFunction` is. `orders.id` is the raw sequential Shopify order id, so
without that gate knowing a number would let anyone void a stranger's label and
trigger a refund against their card.

```
0. Re-check eligibility server-side, from fresh reads
1. Cancel the Amphora return         <-- FAILURE ABORTS, nothing else runs
      Spain         -> the EXTERNAL pre-registration
      International -> the collection
   (Correos labels cannot be cancelled at all — see below)
2. Shopify returnCancel
3. releaseExchangeReservation(orderId)
4. Stripe refund
5. Reset our rows to a clean slate
6. Email the customer, in their locale
```

**Step 1 aborts the whole operation.** It is the one reversal that tells the
warehouse to stop expecting a parcel, and it is the only booking either carrier
path lets us release. If Amphora will not cancel, nothing else changes and the
customer is told to contact us — the return they had is still intact and still
theirs.

Note what step 1 can **not** promise. The original design had it void the
Correos label first, so that no refund was ever issued against a working label.
That guarantee is unavailable: Correos has no cancellation we can reach (below),
so for a Spanish return the label stays live no matter what we do. What
protects us instead is the eligibility gate — a parcel Correos has never
scanned is a parcel the customer still has.

**Past step 1 the logic inverts.** The label is dead, so the customer is owed
their money whatever else fails. Steps 2–4 each continue on failure rather than
abort, because the alternative leaves someone with a voided label and no
refund — strictly the worst outcome available.

**Spain has only one cancellation available.** Since `cbcf511` a domestic return
is both a Correos label and an Amphora EXTERNAL pre-registration. Only the
Amphora side can be cancelled, so that is the one that must not be skipped —
without it the warehouse expects a parcel forever.

**Step 5 cannot reuse `updateFinalOrder(revert)`.** That path refuses outright
to reset any row carrying a `return_id`:

```ts
if (product.return_id) {
  console.error(`... refusing to revert ... Needs manual review, not a revert.`);
  return;
}
```

That guard was added after #310957, where a catch-all revert wiped a live
return, and it must stay exactly as strict as it is. Cancellation is a
different thing: a verified, deliberate reversal that has *already* cancelled
the Shopify return before it writes. It gets its own writer, and the existing
guard is not touched.

The reset clears `confirmed`, `return_id`, `return_line_item_id`, `locator`,
`carrier`, `carrierUrl`, `returnStatus` and the per-line `action` / `reason` /
`notes` / `new_variant_*`, leaving the order as if the customer had never
submitted. They can start a fresh return immediately.

### When a step past 1 fails

Vercel runtime logs are retained for roughly an hour. A `console.error` is not a
durable record of "a human must close this Shopify return" — a production
freeze went unnoticed for nine days in August behind exactly that assumption.

So a failure in steps 2–4 sends an **ops email** to
`hello@shamelesscollective.com` through the Postmark integration already wired
for customer mail, naming the order, the step and the error.

That mail is the only durable trace. Step 5 clears `confirmed`, which drops the
row out of the dashboard's `getReturns` filter, and the log line expires within
the hour — so by the time anyone goes looking, the inbox is the only place the
problem still exists.

## The money

`orders` gains one column:

```sql
ALTER TABLE orders ADD COLUMN stripe_payment_intent text;
```

Written by `app/api/webhooks/stripe/route.ts` on `checkout.session.completed`,
from `session.payment_intent`. Hand-written DDL applied before the deploy that
reads it — there is no committed migration history and `drizzle-kit push` reads
the unmodelled tables in this database as drift and proposes DROPs on live
data (see the schema note in `db/schema.ts`).

Returns booked before this ships have no stored intent. They are recoverable,
because `createStripeUrl` already sets `customer_email` and puts the order id in
session `metadata`:

```ts
stripe.checkout.sessions
  .list({
    customer_details: { email: order.email },
    status: "complete",
    created: { gte: nowSeconds - 90 * 24 * 60 * 60 },
    limit: 100,
  })
  .autoPagingEach(session => {
    if (session.metadata?.id === order.id) { found = session; return false; }
  })
```

The window is a fixed 90 days rather than the order's own age: `orders` has no
timestamp column, so there is nothing to bound it by. Auto-paging is capped at
300 sessions — a customer with more paid checkouts than that in 90 days is not
a real case, and an unbounded scan on a cancel click is. Exhausting the cap
without a match is treated as "no stored intent": steps 1–3 and 5–6 still run,
and the failed refund raises the ops email described above.

`customer_details.email`, `status` and `created` are all supported list filters
in the pinned SDK (stripe 18.2.1, API `2025-05-28.basil`); verified against
`SessionListParams`. The Search API does **not** cover Checkout Sessions, and
our metadata is never copied onto the PaymentIntent, so listing is the only
route — which is why the column exists for everything from here on.

The refund is the full charge: return fee, exchange price difference and both
shipping legs. It carries idempotency key `cancel:${orderId}`, so a double
click, a retry or a resubmitted action cannot refund twice.

Orders that owed nothing — `createStripeUrl` returned `{ data: null }` — skip
step 4 entirely. So does a credit/gift-card return, which mints nothing until
`validateReturn`, and `validateReturn` is blocked by eligibility.

## The screen

A `ReturnStatusPanel` renders above the wizard on `/[id]` whenever the order has
a confirmed return. It shows what was requested, the tracking we have, and
either:

- a **Cancel** button, or
- the plain-language reason there isn't one: "your parcel is already on its way
  to us", "we've already processed your refund", "we can't check on your parcel
  right now — please try again shortly".

Cancelling goes through a confirmation step. It voids a label the customer is
holding in their inbox, and that is worth one deliberate click.

Eligibility is computed on the server for the panel and **computed again inside
the action**. What the page rendered is a hint about what to show, never the
authority on what may happen.

Today a returning customer sees the wizard with confirmed lines locked
(`pointer-events-none` in `productLineClient.tsx`) and dropped from the active
basket. The panel sits above that, unchanged.

Every string — the panel, each blocking reason, the confirmation step and the
cancellation email — is a key in both dictionaries in `lib/i18n`, and the email
is sent in `orders.locale` exactly as the confirmation email is. A customer who
did the whole return in English must not be told it was cancelled in Spanish.

## The stale label — the residual risk, now measured

A cancelled Spanish return leaves a **working** Correos label in the customer's
inbox. This was probed live on 2026-08-12 and is settled, not assumed:

| Attempt | Result |
| --- | --- |
| `BajaOp(codCertificado = <our locator>)` | `Resultado 1`, error 502, "The shipment is not pre-registered in PS2C." |
| `BajaOp(codCertificado = <our CodExpedicion>)` | same 502 |
| `BajaOp(codCertificado = <nonexistent code>)` | same 502 — so 502 is not a "not found" |
| `AnularOp(Oid="", Eid="", codCertificado = <our locator>)` | `Resultado 0` — **and nothing happened** |
| `AnularOp(Oid="AZXT", Eid="AZXT", …)` | 502 again |

The `Resultado 0` is the dangerous one: it looks like success. Two independent
reads afterwards proved it was not. `DocumentacionAduaneraCN23CP71Op` still
found the shipment with its original message, and `SolicitudEtiquetaOp` still
returned `Resultado 0` **with the label PDF**. Correos tracking was also
unchanged, still a single `PRE-ADMISIÓN / Prerregistrado` event.

Accepted, ignored, and indistinguishable from success by the response alone —
the same failure mode as Amphora's `carrier_data` returning 201 while silently
dropping the field. **Never conclude an external write applied from its own
status code; verify through a second, independent read.**

That the identifier is right was proved separately, so 502 cannot be blamed on
it: `DocumentacionAduaneraCN23CP71Op(codCertificado = <our locator>)` located
the shipment and objected only that a domestic `S0132` product carries no
CN23/CP71 — a correct answer about a real record. `codCertificado` is the
`CodEnvio`. `BajaOp` simply operates on a store ("PS2C") our pre-registrations
do not live in, and `AnularOp` needs `Oid`/`Eid` that appear in no request or
response available to us.

So the mitigation is wording, and only wording: the cancellation email states
plainly that the previous label must not be used and that a new return issues a
new one. If a customer ships on the old label anyway, the parcel arrives at
Algete against a return that no longer exists, and it becomes a warehouse
exception like any other unexpected parcel.

Worth revisiting if it bites: because a cancelled locator stays readable, a
periodic check could catch exactly this — a locator belonging to a cancelled
return that reaches `admitido` means the customer shipped anyway. Not in scope
here; noted so the option is not rediscovered from scratch.

## Modules

| File | Responsibility | Depends on |
| --- | --- | --- |
| `lib/cancelEligibility.ts` | **New, pure.** Order row + carrier movement → eligible, or a machine-readable reason. | nothing |
| `lib/trackingStatus.ts` | Existing. Gains the movement predicate over `TrackingPhase`. | nothing |
| `actions/shipping.ts` | Gains a reachability-preserving tracking read. No label cancellation — Correos exposes none we can reach. | Correos |
| `actions/amphora.ts` | Gains `cancelAmphoraReturn(returnId)`. | Amphora |
| `actions/cancelReturn.ts` | **New.** Orchestrates the seven steps. Nothing else calls the externals in this order. | all of the above |
| `app/[id]/components/returnStatusPanel.tsx` | **New.** Renders status + the button or the reason. | `lib/cancelEligibility` |
| `app/api/webhooks/stripe/route.ts` | Persists `stripe_payment_intent`. | — |

`lib/cancelEligibility.ts` is pure on purpose: it is where every rule in this
document lives, and it can be exercised across the whole matrix without a
network, a database or a rendered page.

## Verification

Pure, exhaustive, no mocks — `tests/cancelEligibility.test.ts`:

- no confirmed line → not cancellable
- confirmed, nothing moved → cancellable
- any line `refunded` → blocked, admin-settled reason
- each Amphora status past approval → blocked
- `PENDING` / `APROVED` / null → cancellable
- each Correos phase past `prerregistrado` → blocked
- `prerregistrado` and no-events-yet → cancellable
- `unreadable` → blocked, retry reason (fails closed)

Orchestration with mocked externals — `tests/cancelReturn.test.ts`:

- happy path: Correos voided, Amphora cancelled, Shopify cancelled, hold
  released, refund issued, rows reset, customer emailed
- a Spanish return cancels the Amphora pre-registration and never calls Correos
- **Amphora cancel fails → no Shopify call, no refund, rows untouched**
- Shopify `returnCancel` fails → refund still issued, ops email sent
- an order that owed nothing → no Stripe call
- an order with no stored intent → recovered by session lookup
- cancelling twice → second is a no-op, exactly one refund
- ineligible order → refused even when the action is called directly
- no session → refused silently, nothing called

Existing tests that must stay green: the 16 in `orderSession.test.ts`, the
`updateFinalOrder` revert guard, `duplicateSubmit`, `correosDestination` and
`domesticPreregistration`.

`npx tsc --noEmit` before pushing. Vitest does not typecheck, which is how an
ES5 iterator spread reached main and broke two production deploys for nine
days.

## Appendix — the Correos service, for whoever looks next

There is no public documentation for this service. `developers.correos.es` is
behind a login, the old `interfacepreregistroenvios` URL redirects into it, and
the WSDL carries zero `xs:documentation`. Everything below came from reading
the WSDL and probing it.

Fetch the contract with the same HTTP Basic credentials as `PreRegistro`:

```
https://preregistroenvios.correos.es/preregistroenvios?wsdl
```

It declares **21 operations**, not the one we use. Relevant ones:

```
PeticionAnular : Oid, Eid, codCertificado, IdiomaErrores?
PeticionBaja   : codCertificado, IdiomaErrores?
SolicitudEtiqueta            : FechaOperacion, CodEnvio, Care, ModDevEtiqueta …
SolicitudDocumentacionAduaneraCN23CP71 : codCertificado, IdiomaErrores?
```

`codCertificado` and `CodEnvio` are the same identifier under two names — every
post-creation operation takes `codCertificado` and three of them answer with
`CodEnvio` for that same shipment. `codCertificado` is also the only camelCase
element in an otherwise PascalCase schema, which dates it as a later addition.

Neither cancellation operation is usable; see the stale-label section for the
probe results. Two things there are worth carrying forward regardless of this
feature:

- **`Resultado 0` from this service does not mean the write applied.**
  `AnularOp` returned it while changing nothing.
- **`SolicitudEtiquetaOp` re-issues the label PDF for any live
  pre-registration** — a cheap, non-destructive existence check, and the read
  that disproved the cancellation.
