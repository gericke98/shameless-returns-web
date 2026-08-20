# Letting the customer book their own return shipping

**Status:** approved design, not yet implemented
**Date:** 2026-08-20

## The problem

Today a return is shipped one of exactly two ways, chosen for the customer by
their address:

| Lane | Trigger | What happens |
| --- | --- | --- |
| `CORREOS` | Spain | `createShippingLabel` pre-registers a parcel with Correos, stores the PDF, emails the label, then tells Amphora `EXTERNAL`. |
| `AMPHORA` | Anywhere else, flag on | `createInternationalReturn` books a collection; a courier comes to the door. |

Both are billed through `resolveFee`, which charges our own carrier cost by zone
and weight. For some destinations and weights that is expensive, and the
customer has no way to say *"I can post this myself for less."* They can only
accept our price or not return at all.

This adds a third lane, `SELF`: the customer arranges their own courier, pays
their own postage, and tells us the carrier and tracking number afterwards.

**It is offered only when `returnLegCents > 0`.** Where our label or collection
is already free, self-booking could only cost the customer more, and offering it
would invite people to pay postage they did not need to pay.

## What the customer sees

```
submit ──▶ [ our label / collection    €X.XX ]
           [ I'll ship it myself       free  ]   ← only when returnLegCents > 0
                     │
                     ▼
           return created in Shopify, eligibility confirmed
           email: warehouse address + "send us the tracking" link
                     │
                     ▼  (later, after the post office)
           /[id] ──▶ carrier dropdown + tracking number ──▶ confirm
                     │
                     ▼
           Amphora approved with carrier_data; warehouse expects the parcel
```

## Why two steps

At submit time the customer has not been to the post office, so they do not yet
have a tracking number. The alternatives were both worse:

- **Demand tracking upfront** — they would have to pay postage *before* we
  confirm the return is even eligible. Wrong order: we would be taking money
  from people whose return we might reject.
- **Never require tracking** — no proof of postage, and the warehouse cannot
  see the parcel coming.

So the return is created and confirmed first, and tracking is captured on a
second visit. This also happens to sidestep the `carrier_number` write-once
problem below, because we only approve once we actually know the answer.

## Decisions

### The Amphora ticket is created unapproved, and approved later

`preregisterDomesticReturn` already establishes the pattern: create the return
**without** `auto_approve`, then `PATCH /approve` with `carrier_data`. That two-
call split is what stops a courier being dispatched to a parcel that is already
in transit, and it is the same shape used by hand for Dominic Clear (#310969).

For `SELF` the split maps onto the two phases exactly:

| Phase | Amphora call | State |
| --- | --- | --- |
| Submit | `createAmphoraReturn` (no `auto_approve`) | `PENDING` — no courier dispatched |
| Tracking captured | `approveAmphoraReturn(id, carrier_data)` | `APROVED`, carrier + tracking pinned |

A customer who never comes back leaves a `PENDING` ticket. That is safe: nothing
is dispatched and nothing is charged. It is not, however, allowed to be silent —
see *Abandonment* below.

⚠️ **`carrier_number` is write-once at approve.** Re-approving 422s, and
cancel-and-recreate returns the OLD number, so a mistyped tracking number can
never be corrected and desyncs the warehouse permanently. Two consequences,
both load-bearing:

1. The tracking screen has an explicit confirm step saying so.
2. Approval is guarded by `locator IS NULL`, the same idempotency guard
   `createShippingLabel` uses, so a double-submit cannot attempt a second
   approve.

### `carrier` is never null once a SELF row has tracking

`tracksWithCorreos(null)` returns **`true`** — a null carrier means *"our own
Correos label"*. A `SELF` row that failed to write `carrier` would therefore
send a DHL or An Post tracking number to `localizador.correos.es`, which does
not hold it, and the dashboard would report `sin_informacion` for a parcel that
is being tracked perfectly well by its actual carrier.

This is the sharpest trap in the feature. It is enforced three ways: a check
constraint on the table, a non-nullable carrier in the capture form, and a test
pinning it — in the same spirit as the existing `UNKNOWN_CARRIER` test.

### Carrier is a dropdown, not free text

A fixed list plus `Other` gives us a real `carrier_url` to store and a value
`tracksWithCorreos` can reason about. Free text gives us neither, and "corros"
in the warehouse's records helps nobody.

Picking **Correos** from the list is a legitimate choice and works: the tracking
lookup succeeds and the dashboard shows real phases, exactly as it does for a
label we booked.

### Tracking display needs no change at all

`tracksWithCorreos` already routes non-Correos carriers away from the Correos
lookup, and `trackingStatus` already refuses to invent a status — an unknown
carrier reads `sin_informacion`, which is the honest answer. No new code.

### Cancellation opens before tracking, closes after

`cancelEligibility` would currently return `carrier-unreadable` for every
non-Correos `SELF` return, trapping customers who change their mind on the way
to the post office.

A `SELF` return with `locator IS NULL` has had **nothing booked and nothing
posted** — strictly safer to cancel than a domestic return with a live Correos
label, which is already allowed. So:

```
return_method = 'SELF' AND locator IS NULL  ──▶ cancellable
return_method = 'SELF' AND locator IS NOT NULL ──▶ existing rules apply
```

Once tracking exists the parcel is presumed in the network and the existing
signals take over, including `carrier-unreadable` for carriers we cannot read.
That blocks, and blocking is correct — it fails closed.

### The method is persisted before Stripe, not passed through it

`returnFunction` redirects to Stripe for a paid return and comes back through
the webhook, which has no session and no client state. The chosen method must
therefore be **on the order row** before the redirect, exactly as
`persistOrderLocale` already does for the language.

The same ordering constraint applies: it must be written **before**
`createStripeUrl`, because that call reads the order through the request-scoped
`cache()`d `getOrderById`, and a later write would be invisible to it.

### The fee is re-derived server-side from the method

`resolveFee` already decomposes the charge:

```ts
{ feeCents, kind, returnLegCents, outboundLegCents }
```

so `SELF` is a subtraction, not a new pricing path:

| Basket | Charged when SELF |
| --- | --- |
| Pure return | `0` → `createStripeUrl` returns `{data: null}`, free path |
| Exchange | `outboundLegCents` only — we still ship the replacement |

The method arrives from the client because it is genuinely the customer's
choice, but the **amount is never taken from the client** — the existing rule in
`createStripeUrl` stands. Two server-side checks:

1. The method must be one of the three known values.
2. `SELF` is rejected when `returnLegCents === 0`, so the option cannot be
   invoked where it is not offered.

## Data model

Four columns on `orders`. **DDL first, deploy second** — Drizzle builds an
explicit column list from `db/schema.ts` and SELECTs every declared column, so
deploying the schema ahead of the migration breaks *every* order lookup in the
portal, not just this feature.

```sql
ALTER TABLE orders ADD COLUMN return_method text;
ALTER TABLE orders ADD COLUMN return_submitted_at timestamptz;
ALTER TABLE orders ADD COLUMN tracking_submitted_at timestamptz;
ALTER TABLE orders ADD COLUMN tracking_nudge_stage smallint NOT NULL DEFAULT 0;

ALTER TABLE orders ADD CONSTRAINT orders_self_return_needs_carrier
  CHECK (return_method <> 'SELF' OR locator IS NULL OR carrier IS NOT NULL);
```

| Column | Meaning |
| --- | --- |
| `return_method` | `'CORREOS' \| 'AMPHORA' \| 'SELF'`. Null on legacy rows, inferred by country as today. |
| `return_submitted_at` | When the return was confirmed. **`orders` currently has no timestamp column at all**, so without this there is nothing to measure the abandonment window against. Null on legacy rows, which the sweep skips. |
| `tracking_submitted_at` | Null while awaiting tracking. |
| `tracking_nudge_stage` | `0` none, `1` reminder sent, `2` ops alerted. Makes the sweep's once-only guarantee a stored fact rather than a recomputation. |

Carrier and tracking reuse the existing `locator` / `carrier` / `carrier_url`,
so the dashboard, the tracking route and the status panel all keep working
unchanged.

**No column for the Amphora ticket id** — it is already derivable from
`amphoraOrderIdFromShopifyId(order.id)`, and a second source of truth for it
would only be a thing that can disagree.

## Components

| Unit | Responsibility |
| --- | --- |
| `lib/returnMethods.ts` (new, pure) | Which methods are offered for a basket + zone; validates a claimed method. No db, no network — testable like `lib/fees.ts`. |
| `actions/selfBookedReturn.ts` (new) | `createSelfBookedReturn(id)` — books nothing, creates the unapproved Amphora ticket, emails instructions. Returns an HTTP-style status like its two siblings. |
| `actions/selfBookedTracking.ts` (new) | `submitReturnTracking(id, carrier, number)` — session-gated, idempotent on `locator`, writes the three columns then approves Amphora. |
| `actions/return.ts` | `createReturnShipment` gains the third branch; `returnFunction` persists the method before Stripe. |
| `actions/payments.ts` | `createStripeUrl` takes the method and charges the outbound leg only for `SELF`. |
| `lib/selfReturnNudges.ts` (new, pure) | Given a row and "now", decides which nudge (if any) is due. No db, no clock of its own — so the 3/10-day matrix is testable without waiting ten days. |
| `actions/selfReturnSweep.ts` (new) | Applies that decision: advance the stage, then send. Called from the existing `amphora-sync` cron route. |
| `lib/cancelEligibility.ts` | The pre-tracking window above. Stays pure. |
| `app/[id]/` | Method choice on the submit flow; tracking capture screen when `SELF` and no locator. |
| `lib/emails.ts` | Two new templates: instructions-with-address, and the day-3 reminder. Both `es`/`en`. |

## Abandonment

A customer who picks `SELF` and never returns leaves a live Shopify return and a
`PENDING` warehouse ticket. Order #311174 is the standing lesson here: a state
nobody is told about is a state that persists for eight days until the customer
complains.

Driven from the **existing** `amphora-sync` cron — it already runs every 15
minutes, so no new cron, no new secret, and nothing new to misconfigure. The
sweep selects `return_method = 'SELF' AND tracking_submitted_at IS NULL AND
return_submitted_at IS NOT NULL`, and measures age from `return_submitted_at`:

| Age | Action | Guard |
| --- | --- | --- |
| 3 days | Reminder email to the customer | `tracking_nudge_stage = 0` → set `1` |
| 10 days | `alertOps`, naming the order, customer and age | `tracking_nudge_stage < 2` → set `2` |

**The stage is advanced before the send, not after** — the same ordering
`applyReturnStatus` uses, and for the same reason: a redelivery or the next tick
then finds the stage already advanced and does nothing. The cost is that a
failed send is not retried, which is why the failure is logged loudly. Deriving
"already nudged" from age alone would send 96 reminders a day.

## Testing

TDD throughout, mirroring the existing suites.

| Area | What is pinned |
| --- | --- |
| Fee | `SELF` drops the return leg and keeps the outbound leg; a pure return charges nothing; an exchange still pays for the replacement. |
| Offer gate | Hidden when `returnLegCents === 0`; a client claiming `SELF` there is rejected server-side. |
| Submit | `SELF` books no carrier; the Amphora ticket is created **unapproved**; no email claims a label exists. |
| Tracking capture | Approves Amphora with carrier data; a second submit is a no-op and never re-approves. |
| The null-carrier trap | A `SELF` row with a locator always has a carrier. |
| Cancellation | Allowed before tracking, existing rules after. |
| Abandonment | Reminder and alert each fire exactly once, not once per cron tick; a row with a null `return_submitted_at` is skipped rather than treated as infinitely old. |

## Risks

**Customs on international self-booked returns.** A customer posting from
outside the EU customs territory arranges their own paperwork. If they get it
wrong the parcel can be held, surcharged or returned to them, at their cost, and
they will reasonably ask us to fix it. Our own Correos path handles CN23 only
for Canary/Ceuta/Melilla *senders*; nothing here does it for them. Mitigated by
an explicit warning in the instructions email, not solved. **This feature will
generate support load that the two existing lanes do not.**

**No proof the parcel exists.** A tracking number is a string; nothing verifies
a parcel was ever handed over. The existing safety net holds — refunds are
already a manual dashboard action (`validateReturn`), so a human sees every
settlement before money moves.

**A typo is permanent.** Covered by the confirm step, but it will still happen.
When it does, the warehouse record is wrong forever and the parcel has to be
reconciled by hand on arrival.
