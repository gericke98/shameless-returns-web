# An exchange keeps the price you paid

**Date:** 2026-09-01
**Status:** design, approved for planning
**Branch base:** `main` (`35b2dc9`)

## The problem

Fran Cobo bought two garments during a sale and wants both in a smaller size.
The portal asks him to pay €6.60 to swap sizes. He wrote in rather than pay it:

> when I try to do the exchange, it doesnt keep the price for which I bought (i
> bought during sales). Instead, it makes me pay the difference, in which case I
> will rather return and refund

He is right, and the money is real.

**Order #311749**, placed 2026-08-27:

| Line | List then | Paid | Depth |
|---|---|---|---|
| MENTALITY CREWNECK, Large | €55.00 | €42.75 | −22.3% |
| STAR AMALFI PANTS, Large (42) | €69.00 | €47.03 | −31.8% |

`applyGlobalDiscount` (`lib/basket.ts:18`) derives **one** ratio from
`order.products[0]` and applies it to every variant in the catalogue:

```
ratio = 42.75 / 55.00 = 0.7773          from line 1 only
pants replacement = 69.00 × 0.7773    = €53.63
Fran actually paid                    = €47.03
                                        ────────
                                        €6.60 overcharge
```

The crewneck prices correctly — it *is* line 1. The pants do not. `loadBasket.ts:14`
and `app/[id]/page.tsx:78` both feed `order.products[0]`, so the on-screen summary,
the Stripe amount and the confirmation all agree on the same wrong number.

## Root cause

The replacement price is modelled as a property of the **catalogue** rather than
of the **(line, replacement) pairing**. `applyGlobalDiscount` rewrites the whole
product list with a single ratio, so a given variant has exactly one price no
matter which line it replaces. That is sound only while every line in an order
carries the same discount percentage — an assumption a sale with per-product
markdown depths violates by construction.

Three consequences fall out of the same design:

- **`order.products[0]` is not deterministic.** `insertOrderItems`
  (`actions/order.ts:230`) inserts via `Promise.all`, and the Drizzle relational
  read has no `ORDER BY`. Which line sets the ratio for the entire order is
  incidental.
- **It fails toward the merchant.** When line 1 was discounted less deeply than
  the line being exchanged, the customer overpays. The reverse also happens and
  nobody reports it. Neither direction fires an alert.
- **The rule is duplicated.** `valueBasket` (`lib/basket.ts:123`),
  `thirdWindow.tsx:191`, `summary.tsx:117`, `dialogForm.tsx:46/68/91/124` and
  `productLineClient.tsx:186/281` each independently resolve a replacement price.
  This is the shape of the `return-fee-two-collection-points` incident: one rule,
  many collection points, and only a whole-branch review catches the one you missed.

## What the investigation established

Measured against live data on 2026-09-01.

### Three quarters of exchanges need no catalogue at all

289 `CAMBIO` lines carry a chosen replacement:

| | lines | |
|---|---|---|
| Same-product size swap | **221 (76%)** | needs `line.price` only |
| Cross-product | 68 (24%) | needs a ratio |
| Original variant absent from the active catalogue | **0** | fallback is unreachable in production data |

The overwhelming majority case is a size swap, whose correct answer is "what you
paid" — no catalogue lookup, no ratio, no arithmetic that can drift. Today's code
routes all 289 through catalogue arithmetic none of the 221 need.

### The catalogue cannot drift far

`isWithinReturnPeriod` (`utils/order-utils.ts:50`) caps returns at 60 days, so an
exchange is always priced against a catalogue at most ~60 days newer than the
order. That upstream rule is why 0 of 289 originals had left the catalogue, and
it is the reason this design needs no price history.

### Historical damage: indicative, and a better query exists

Of 266 orders containing an exchange, 69 are multi-line, and **35 lines** were
priced through a ratio borrowed from a different line. Reconstructed against
*today's* catalogue: 17 overcharged, 18 undercharged, net €15.23.

**Those euro figures are indicative only.** They were computed with the current
catalogue rather than the catalogue as it stood at each exchange, so individual
amounts are unreliable. Fran's €6.60 is exact only because his two products have
not moved since 2026-08-27.

The exact query becomes available once the new rule exists, and it needs no price
archaeology: under the rule below, an all-same-product exchange owes **exactly
€0**. So any historical order whose `CAMBIO` lines were all same-product size
swaps, but which carries a Stripe `difference` line item, is a confirmed
overcharge for precisely that amount. That is phase 3.

### Storing the paid price was rejected

An earlier draft proposed freezing prices on `productsorder` at ingest. It is not
needed:

- The **paid price** is already `productsorder.price` and remains derivable from
  the Shopify order line item indefinitely (`price` − `discount_allocations`).
  Storing it again is redundant.
- The **reference price** the discount was measured against is genuinely
  unrecoverable — the Shopify order line item exposes only `price`, `price_set`,
  `total_discount`, `total_discount_set` and `discount_allocations`, with no
  `compare_at_price`, and both of Fran's live variants now report
  `compareAtPrice: null`. But the design below never asks for it: the
  cross-product ratio reads the *current* price of the original variant, not a
  historical one.

No migration, no backfill.

## The rule

A new pure module, `lib/replacementPricing.ts`:

```ts
replacementPrice(line, catalogue): number
```

1. The replacement variant belongs to the **same product** as the line → return
   `line.price` verbatim. No catalogue arithmetic, no ratio. A size swap is
   structurally incapable of producing a charge.
2. **Different product** → `ratio = line.price / currentPriceOf(line.variant_id)`,
   clamped to `(0, 1]`; return `currentPriceOf(new_variant_id) × ratio`. The clamp
   matters in both directions: it stops a replacement being priced above its own
   list price when the original has since been marked down below what was paid.
3. The original variant is absent from the catalogue → fall back to the **median
   ratio of the order's resolvable lines**; if none resolve, `ratio = 1`. Today this
   case silently charges full price and says nothing.

`replacementPricing` stays **pure** — no db, no env, no network — for the same
reason `lib/basket.ts` does: it must be unit-testable and safe to import from a
client component. `alertOps` is a server action (`actions/opsAlert.ts`), so the
module cannot call it. Instead it returns the fallback it took alongside the price:

```ts
{ price: number, basis: "paid" | "ratio" | "median" | "none" }
```

`"median"` and `"none"` are the degraded paths, and the **server-side callers**
(`lib/loadBasket.ts`, and `createStripeUrl` before it charges) fire `alertOps`.
Client components read `.price` and ignore `.basis`.

`applyGlobalDiscount` is deleted. The catalogue is passed down **raw**, so no
object in the system carries a price that is not a real price.

### The id-shape trap

`productsorder.variant_id` is a **bare numeric id**; `new_variant_id` and every
catalogue id are **full GIDs** (see the `productsorder-variant-id-shapes` note).
The step-2 lookup of the *original* variant must normalize through `variantGid()`.
Without it the cross-product branch falls through to the step-3 fallback on every
single line — the branch ships, the tests on the same-product path pass, and
nothing appears to be wrong.

## Call sites

All nine convert in one branch:

| File | Change |
|---|---|
| `lib/loadBasket.ts:14` | stop pre-discounting; pass the raw catalogue |
| `app/[id]/page.tsx:78` | same |
| `lib/basket.ts` `valueBasket` | call `replacementPrice` per line |
| `app/[id]/windows/thirdWindow.tsx:180-205` | delete the inline duplicate; call `valueBasket` |
| `app/[id]/components/summary/summary.tsx` | price per line |
| `app/[id]/components/productLineClient.tsx:186/281` | price per line |
| `app/[id]/components/dialogForm.tsx:46/68/91/124` | price per line via `replacementPriceForVariant(line, variantId, catalogue)` |

The picker in `dialogForm` especially: with a raw catalogue it would otherwise
quote €55 for a garment the customer will actually receive for €42.75.

`createStripeUrl` (`actions/payments.ts`) needs **no change** — it already derives
its amount from `basket.netAmount`, so fixing `valueBasket` fixes the charge.

## Riding along: `calculatePriceWithDiscount`

`utils/order-utils.ts:41` subtracts a **line-total** discount from a **unit**
price and reads only `discount_allocations[0]`:

```ts
return Number(item.price) - (item.discount_allocations?.[0]?.amount ?? 0);
```

Wrong for `quantity > 1` and for stacked discounts. It is **latent** — zero
qty>1 discounted lines in the last 250 orders — but it corrupts the very
`line.price` that phases 1 and 2 make load-bearing, so it is fixed here as its
own commit.

Also latent and fixed cheaply: `db/queries.ts:1288` fetches `variants(first: 10)`.
No active product exceeds 10 variants today, but one with more sizes would
silently lose them from the picker.

## Testing

`replacementPricing` is pure, so it is unit-tested exhaustively:

- **Regression, #311749.** Fran's exact numbers: crewneck €42.75 → €42.75, pants
  €47.03 → €47.03, basket delta €0.00.
- **Property.** A same-product swap yields a €0 delta for *any* catalogue, including
  an empty one.
- Cross-product upgrade, cross-product downgrade, ratio clamped at 1.
- Step-3 fallback — asserted through the returned `basis`, unit tests only. It is
  unreachable in production data (0/289) and must not be waved through on
  integration coverage. A separate test covers `loadBasket` firing `alertOps` when
  `basis` comes back degraded.
- The `variantGid()` normalization, asserted directly: a bare `variant_id` must
  resolve, or the cross-product branch is dead.

## Phasing

| Phase | Scope | Success criterion |
|---|---|---|
| 1 | `lib/replacementPricing.ts` + unit tests | #311749 regression passes; same-product property holds |
| 2 | Convert all nine call sites; delete `applyGlobalDiscount` | `grep applyGlobalDiscount` returns nothing; UI, summary and Stripe amount agree on one number |
| 3 | Exact historical audit via Stripe `difference` lines on all-same-product exchanges | Confirmed overcharge list with euro totals, for a refund decision |
| 4 | #311749 made whole | Fran's exchange completes at €0 |

## Open decision left to the merchant

The **cross-product branch** (step 2) is pricing policy, not mechanics: whether a
customer swapping to a *different* garment keeps their sale depth at all, and what
should happen when the original has since been re-marked-down. The function will be
scaffolded with the same-product branch and the tests in place, and that branch left
for Santiago to write.

## Non-goals

- Changing what a plain return refunds.
- Changing the return fee or either shipping leg.
- Re-pricing the Shopify exchange draft order, which holds stock rather than
  charging the customer.
