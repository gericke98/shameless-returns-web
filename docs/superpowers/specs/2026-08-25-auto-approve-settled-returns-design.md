# Auto-approving returns that are already in the warehouse

**Date:** 2026-08-25
**Status:** design, approved for planning
**Branch base:** `fix/credit-lane-shopify-refund`

## The problem

Every return in this business is settled by hand. A human opens `/dashboard`,
looks at a row, decides the return is fine, and clicks the button that runs
`validateReturn` — which mints a gift card, issues a refund, or ships an
exchange, then closes the Shopify return and flips `productsorder.refunded`.

Nothing about that judgement is hard. For the overwhelming majority of returns
the human is confirming two things: **the goods came back**, and **we have not
already paid**. Both are facts a machine can read.

The cost of doing it by hand is a queue. At the time of writing there were 168
confirmed-but-unsettled lines, some months old — customers waiting on money for
returns that arrived at the warehouse weeks ago.

## What we are building

A daily cron, `/api/cron/auto-approve`, that finds returns whose garments are
provably in the warehouse and provably unpaid, and runs the exact settlement the
dashboard button runs.

## What the investigation established

These are measured facts, not assumptions. Each one changed the design.

### Amphora reports what it actually received

`GET /returns` returns per-item `quantity_received`, distinct from the declared
`quantity`:

```
#310847  APROVED   items: [{ sku: "20251604", quantity: "1", quantity_received: "0" }]
#310185  RECEIVED  items: [{ sku: "20250503", quantity: "1", quantity_received: "1" },
                           { sku: "20250504", quantity: "1", quantity_received: "1" }]
```

It is a genuine receipt count from the warehouse, not our own declaration echoed
back. **Both fields arrive as strings** — `"0"` is truthy, so every comparison
must coerce with `Number()`.

The response also carries per-transition timestamps (`time_received`,
`time_processed`, `time_finished`), which is what makes a grace period possible.

### No rejected return exists to look at

Across 143 live returns the statuses observed were `PENDING`, `APROVED`,
`TRAVELLING`, `PROCESSING_WAREHOUSE`, `RECEIVED`, `FINISHED`. Not one
`EXCEPTION*` and not one `FINISHED_REJECTED`.

We therefore cannot know what a rejected return looks like on the wire. The gate
must be an **allowlist** of the three warehouse statuses, never a blocklist of
the bad ones — so a status string we have never seen fails closed instead of
paying someone out.

### `refunded` had drifted from Shopify on a third of the backlog

Of 168 unsettled lines, **52 were already finished in Shopify** — 50 `CLOSED`,
2 `CANCELED`. `productsorder.refunded` is written in exactly one place, the
dashboard button. Anything settled in the Shopify admin instead never reaches
us, and the row sits looking unpaid forever.

This is the finding that most shaped the design. A gate built only on Amphora
answers *"did the goods come back"*. It says nothing about *"have we already
paid"*. **Those are different facts and the job needs both.** Without the
Shopify check, the first run would have re-refunded roughly 49 customers.

Backfilled to `refunded = true` on 2026-08-25 (52 rows; backlog 168 → 116).
Six of them were `CLOSED`/`CANCELED` with no refund recorded on the order —
`#36836`, `#310185`×2, `#310969`, `#39315`, `#36032` — confirmed by the owner as
settled through another channel.

### Domestic is 85% of the work, and is reachable

142 of the 168 unsettled lines were domestic. `amphora-sync` skips every
domestic order (`route.ts:129`) to avoid overwriting the Correos tracking a
customer is watching — but that exclusion protects a **write**. Reading
`quantity_received` touches neither `carrier` nor `locator`, so the reason does
not carry over to settlement.

Amphora is the 3PL that receives every box, Spanish ones included, and
`matchReturnsToOrderIds` already matches their own arrival records via the
`SHP <shopify order id>` return id. Domestic needs no new matching machinery.

For a domestic return the dashboard currently shows the human a *Correos*
status — the courier saying it dropped the parcel off. `quantity_received` is
the warehouse counting garments in the box. The automated gate is **stricter
than the human judgement it replaces.**

## Design

### 1. Extract the settlement core

`validateReturn` is today `isAdmin()` + all three payout lanes + `revalidatePath`
in one function. Split it:

- `lib/settleReturn.ts` — the three lanes, no auth, no cache invalidation.
- `actions/refund.ts::validateReturn` — `isAdmin()` → core → `revalidatePath`.
- the cron — auth → core.

The money logic must exist exactly once. The return-fee rule already lives in
[four places](../../../docs) across the codebase; the 1.15 credit multiplier and
the €5 deduction must not gain a fifth by being copied into a cron.

### 2. The gate — `lib/autoApproveGate.ts`

Pure. No db, no network, no env. Takes our lines, the matched Amphora return and
the Shopify return status; returns a per-order verdict. Settles only when **all**
hold:

| condition | rationale |
|---|---|
| Amphora `internal_status` ∈ `{RECEIVED, PROCESSING_WAREHOUSE, FINISHED}` | allowlist; unknown fails closed |
| every declared line has `Number(quantity_received) >= quantity` | the goods are actually here |
| Shopify `Return.status === "OPEN"` | we have not already paid |
| `time_received` at least `GRACE_DAYS` old | the warehouse gets a window to raise an incidencia |
| our line is not already `refunded` | belt and braces against a stale read |

A Shopify return that cannot be read is **ineligible**, never assumed `OPEN`.

**Short receipt holds the whole order.** If any declared line is short, nothing
on that order settles and it is logged for a human. A short count means
something went wrong, and those are exactly the ones that want eyes. This also
sidesteps a structural problem: the `CAMBIO` lane batches every pending exchange
line on an order into one Shopify order and one parcel, so partial settlement of
an exchange is not expressible anyway.

### 3. The cron — `/api/cron/auto-approve`

Daily, separate from the 15-minute `amphora-sync`. Different cadence, far larger
blast radius, and a failure in one must not take out the other.

- `CRON_SECRET`-gated, unset secret = closed, matching `amphora-sync`.
- `AUTO_APPROVE_ENABLED` — kill switch, flippable in Vercel with no deploy.
- `AUTO_APPROVE_GRACE_DAYS` — default `2`.
- `AUTO_APPROVE_MAX_PER_RUN` — default `25`. The 116-line backlog drains in
  about five days. If the gate is wrong we learn it after 25 mistakes, not 116.
- `?dry=1` — reports what it would settle and writes nothing.

**Each line is re-read fresh immediately before it is settled**, never trusted
from the list loaded at the top of the run. `tests/freshOrderRead.test.ts`
already pins this lesson for settlement, and a loop paying out 25 lines is
precisely where a stale read becomes a double payment.

One line failing must not abort the sweep — the others are still owed their
money. Per-line try/catch, and `alertOps` on anything that fails after money has
moved, following the asymmetry `validateReturn` already documents in its
store-credit branch.

### 4. Observability

Every run logs: scanned, settled, held-and-why, capped. A held order names the
order number, never a bare count — the whole point is that a human can act on it
without going back to the Amphora UI.

## Testing

Unit, against `lib/autoApproveGate.ts` (pure, so all of this is cheap):

- `quantity_received: "0"` does not settle — the string-truthiness trap
- `"1"` vs `1` compare equal
- an unknown status (`EXCEPTION_WAREHOUSE`, and a made-up string) does not settle
- Shopify `CLOSED` / `CANCELED` / unreadable does not settle
- one short line holds every line on the order, including its exchange siblings
- `time_received` inside the grace window does not settle

Integration, against the route with Amphora, Shopify and db mocked:

- the per-run cap is respected and the remainder is left untouched
- `?dry=1` writes nothing and calls no payout
- one throwing line does not stop the ones after it
- a line refunded between the list read and the settle is skipped

## Explicitly not in scope

- Re-driving `orders.returnStatus` for domestic orders. Settlement reads
  Amphora; it does not start writing domestic tracking.
- Any change to what `validateReturn` pays. This job decides *when* to settle,
  never *how much*.
- Auto-handling `EXCEPTION*` returns. Those stay entirely manual.
