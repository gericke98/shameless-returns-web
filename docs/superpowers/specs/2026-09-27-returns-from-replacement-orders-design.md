# Returns from replacement orders — design

**Date:** 2026-09-27
**Status:** approved in conversation, awaiting written-spec review
**Branch:** `fix/returns-from-replacement-orders`

## Problem

When an exchange settles, `createOrder` (`db/queries.ts`) creates a *replacement
order* in Shopify. That order:

- carries a single **€0.01 `manual` SALE** transaction as a placeholder, and
- prices its lines at the **current list price**, not what the customer paid.

The portal treats a replacement order like any purchase. A customer who returns a
garment from it gets a `productsorder` row priced at list (€62 instead of the
€47.03 actually paid) and a `transaction_id` pointing at the €0.01 placeholder.

Consequences seen in production:

- **Refund lane:** Shopify refuses (`Refund amount €57.00 cannot be greater than
  the net payment received €0.01`). #312061 failed the 2026-09-26 auto-approve
  run; #312060 will fail the same way once its grace period ends. Had Shopify
  accepted, the customer would have been overpaid ~€15.
- **Store-credit lane:** the gift card is valued from the list price, so it
  overpays. #37825 and #37931 were paid this way.

Scale: 14 replacement orders have ever been looked up in the portal; 4 rows are
confirmed and unsettled (#312060, #37841, #37863, #37930). #312061 was settled
by hand on 2026-09-27 (refund €42.03 on #311749).

## Policy (decided)

1. A return from a replacement order offers **everything** the portal normally
   offers — refund, store credit, another exchange.
2. Every garment is valued at **what the customer paid on the original order's
   line**. A card refund goes against the **original order's** real payment.
3. If the customer paid a **Stripe top-up** to swap to a pricier product, the
   automatic refund still pays only the original line price, and **ops is
   alerted** to refund the top-up by hand from Stripe. (22% of exchanges are
   product swaps; returns *from* replacement orders are rare, so manual top-up
   handling stays rare.)

## Design

### 1. Recognising a replacement order — portal lookup

On first lookup (`actions/order.ts` → `saveOrderDetails` / `insertOrderItems`):

- A **pure** helper `lib/replacementOrigin.ts` parses the REST order's `tags`.
  It is a replacement order iff the tags contain `Change` **and exactly one**
  `Order #NNN`. Anything else (no `Change`, zero or several `Order #…`) → not a
  replacement order, normal path. `createOrder` writes exactly these two tags.
- The original order is looked up **in our DB** by `order_number`. It must exist:
  we only ever create replacements from orders we hold. If it does not → fail
  closed (below).
- **Chains resolve to the root.** If the original is itself a replacement order
  (its `exchange_of` is set), `exchange_of` on the new order is the original's
  `exchange_of`. The root is the only order that holds real money.
- **New column `orders.exchange_of`** (text, nullable) — the root order's id.
  NULL means "not a replacement order". Migration applied by hand on
  `ShamelessReturns` **before** deploy and verified via `information_schema`
  (see the PR #38 outage: Drizzle's explicit column list breaks every `orders`
  read if the column is missing).
- **Line price:** for each replacement line, the matching row is the one on the
  *immediate* original order (not the root) with `action = 'CAMBIO'`,
  `confirmed = true`, and `new_variant_id` equal to this line's variant (compare
  through `variantGid()` — `new_variant_id` is a full GID, `variant_id` bare).
  The new row's `price` is that row's `price`.
- **Fail closed.** If the original is not in our DB, or any line has zero or
  more than one matching row: do not save the order with list prices. The lookup
  returns the existing "contact support" style message and `alertOps` fires with
  the order number and the reason. Never fall back to list price.

### 2. The refundable transaction — return creation

In `actions/updateOrder.ts`, where `transaction_id` / `transaction_amount` are
written after `returnCreate`: when the order's `exchange_of` is set, take them
from `pickRefundTransaction()` over the **root order's** Shopify transactions
instead of `result.data.transactionId`. If that yields null, store null — the
refund lane already refuses a null transaction with `no-refund-transaction`
and the cron alerts on it.

### 3. Settlement — `lib/settleReturn.ts`

**Store-credit and exchange lanes:** unchanged. They read `trustedLine.price`,
which §1 makes correct. (A further exchange from a replacement order produces a
replacement whose tag points at the replacement; §1's chain rule handles it.)

**Refund lane, when the order's `exchange_of` is set** — replaces the single
`returnRefund` with a two-order sequence, in this order:

1. **Idempotency check.** Read the root order's refunds. If any refund's note
   contains this line's `return_line_item_id`, the money already moved: skip to
   step 3.
2. **Money.** `refundCreate` on the root order, against `trustedLine.transaction_id`,
   amount = `price − 5` (or `price − 0` if self-booked — the same rule as today),
   in the root order's presentment currency, `notify: true`, note containing the
   replacement order number and the `return_line_item_id` (the marker).
   On failure → `{ settled: false, reason: "refund-failed" }`, nothing else runs.
3. **Mark the row `refunded = true` immediately** — before any further Shopify
   call. A crash after this point can never pay twice.
4. **Goods.** Zero-transaction `returnRefund` (reuse `createStoreCreditRefund`,
   which omits `orderTransactions`) + `closeReturn` on the replacement order.
   Failure here → `alertOps` naming the return, but the row stays refunded and
   the outcome is still `settled: true` (the customer is paid; the booking is
   accounting cleanup).

**Top-up alert:** after a successful refund-lane settlement on a replacement
order, if the matched original row was a swap to a **different product**
(original `product_id` ≠ this line's `product_id`) **and** the immediate original
order has a `stripe_payment_intent`, `alertOps`: "customer may be owed a top-up;
check Stripe <payment intent>". Informational — never blocks settlement.

The same top-up alert fires on the store-credit lane, since that lane also pays
only the original price.

### 4. Existing rows — one-off repair

The lookup only runs once per order, so replacement orders already in the DB keep
their wrong values. A one-off script (pattern: `8263760`, "repair the 6 rows"):

- targets orders whose tags mark them as replacements and that have **confirmed,
  unsettled** rows (expected: #312060, #37841, #37863, #37930);
- sets `orders.exchange_of`, each row's `price` (via §1's matching) and
  `transaction_id` / `transaction_amount` (via §2);
- **dry-run by default**, prints before/after per row, writes only with an
  explicit flag; rows that fail matching are listed, not guessed.

Already-settled historical rows (including the overpaid #37825 / #37931 gift
cards) are **out of scope** — reported, not corrected.

## Testing

- **Unit (pure):** tag parsing (Change + one Order #, missing Change, zero / two
  Order tags); chain resolution to root; line matching including GID vs bare id,
  zero matches, two matches.
- **`settleReturn`:** clean two-order refund (money on root, goods on
  replacement, row refunded); refund failure → nothing marked; **money succeeds,
  goods booking fails → row refunded, alert fired, and a second call pays
  nothing** (via `already-refunded` and via the marker check when the row flag
  is absent); non-replacement orders untouched.
- **Revert proof:** each test claiming to pin the new wiring must be shown to
  fail with the wiring reverted.
- Full suite with `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`.

## Rollout

1. Apply migration on `ShamelessReturns`; verify with `information_schema`.
2. Merge + deploy (push to `main`).
3. Run the repair script dry, review, run for real.
4. Watch the next 07:00 auto-approve run for #312060.

## Out of scope

- Putting paid prices on the replacement order itself at `createOrder` time
  (approach C) — a possible follow-up.
- Automating Stripe top-up refunds.
- The exchange lane's stock-hold issues (release-before-create; one sold-out
  size blocking all lines) — separate change.
