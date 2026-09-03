# Collect here, deliver there

**Date:** 2026-09-02
**Status:** design, approved for planning
**Branch base:** `main` (`86d7fc7`)

## The problem

A customer is in Spain with a garment they want to exchange. They ship the
parcel back from Spain, as any Spanish customer would. But they want the
replacement sent to the United States.

The portal cannot express this, because there is only one address. `orders`
carries a single `shipping_*` block and it serves both journeys at once:

- `actions/shipping.ts` puts it in the Correos `<Remitente>` — where the parcel
  is **collected**.
- `db/queries.ts:661` puts it in the exchange order's `shippingAddress` — where
  the replacement is **delivered**.

One address, two legs, pointed in opposite directions. Today the second
silently follows the first.

The money follows the same single address. `resolveZone(shipping_country,
shipping_zip)` picks one row of `shipping_fees`, and `resolveFee`
(`lib/fees.ts:93`) splits that row's pair into two legs that are both priced as
if the parcel never left the country it was collected from:

| 1 kg parcel | return leg (collect) | outbound leg (deliver) | combined |
|---|---|---|---|
| ES | €5.00 | €3.50 | €8.50 |
| US | €22.00 | €12.96 | €34.96 |

So a Spain→US exchange should cost **€5.00 + €12.96 = €17.96**. Priced as
Spanish, it costs **€8.50**. The shop absorbs the €9.46 difference on every one.

## What this is not

The country field on the address form is deliberately read-only, and the
reasoning is written down in three places — `secondWindowForm.tsx:105-115`,
`updateOrder.ts:180-192`, and `zones.ts:56-70`. All three give the same two
reasons: the country picks the carrier lane, and a customer who picks their own
country picks their own price.

**Both reasons still stand and this design does not touch them.** The
collection address keeps its locked country. What is added is a *second*
address, for the outbound leg only — a leg that has no carrier lane, no
`locator`, and no customs declaration to misroute.

## Design

### 1. Data model

Seven nullable columns on `orders`:

```
delivery_name, delivery_address1, delivery_address2,
delivery_zip, delivery_city, delivery_province, delivery_country
```

**NULL means "deliver to the collection address."** Every existing row keeps
today's behaviour exactly, and there is no backfill. The migration is additive
and reversible.

The existing `shipping_*` columns keep their current meaning — the collection
address — and their locked country.

### 2. Pricing

`resolveFee` already models the fee as two legs and derives the outbound one by
subtraction (`lib/fees.ts:125`). It resolves both from a single band list. The
change is to give it two:

```
returnLegCents   ← bands for resolveZone(shipping_country, shipping_zip)
outboundLegCents ← bands for resolveZone(delivery_country, delivery_zip)
```

The subtraction stays as it is: `outbound(dest) = dest.exchangeFee −
dest.returnFee`. For the US that is `3496 − 2200 = 1296`, which is the store's
own published delivery price to the USA — the basis established in `7919d72`
and unchanged here.

**The second band list is a required parameter, not one defaulting to the
first.** A default would compile silently at all seven call sites. Requiring it
makes TypeScript enumerate them. This repo has already shipped a fee rule that
lived in four places where twelve task reviews missed one
(`return-fee-two-collection-points`); the compiler is a better reviewer than we
are.

Call sites to update: `summary.tsx:94`, `lastWindow.tsx:62`,
`secondWindow.tsx:53`, `secondWindowForm.tsx:43`, `payments.ts:60`,
`return.ts:76`, and `scripts/verify-311749-fix.ts:300`.

### 3. Blast radius — what does *not* change

All three price computations were traced. Only one touches the outbound leg:

| Place | Reads | Affected |
|---|---|---|
| `actions/payments.ts:60` — the Stripe charge | both legs | **yes** |
| `lib/settleReturn.ts:115` — gift-card lane | `returnFeeCents` only | no |
| `lib/settleReturn.ts:257` — refund lane | hardcoded `− 5` | no |
| `actions/updateOrder.ts:374` — fee sent to `returnCreate` | `returnFeeCents` only | no |

Both settlement deductions are return-leg-only. **The delivery country cannot
desync the charge from the settlement**, which is the failure mode that makes
fee changes dangerous in this codebase.

Also untouched, all of it keyed off the collection address which never moves:

- Correos vs Amphora lane selection (`actions/return.ts:78`)
- customs / CN23 (`requiresCustomsData`)
- `orders.locator`, `orders.carrier`, Amphora's pinned `carrier_number`
- the Correos `<Remitente>`
- `resolveZone`'s Spanish sub-zone logic

The single consumer that must switch: `db/queries.ts:661`, the exchange order's
`shippingAddress`. Its `billingAddress` stays with the collection address.

That switch drags `provinceCode` with it. `db/queries.ts:595` derives the
province as:

```
countryCode === "ES" ? getProvinceCode(province ?? city) : undefined
```

Both halves must read the **delivery** address once one exists, and they must
move together. Reading the delivery country against the collection city is
precisely the shape of the bug that sent `Woluwe-Saint-Pierre` to Shopify as a
province code (`759bb1b`, PR #31) — a Spain→US delivery would otherwise take the
`undefined` branch correctly but a US→Spain one would read a Spanish province
off the wrong address.

### 4. UI

In the address step, shown **only when the basket contains an exchange** — a
pure return has no outbound leg to redirect:

> ☐ Deliver my replacement to a different address

Collapsed, the screen is exactly what it is today. Expanded, a full address
form whose country is a `<select>` restricted to `SUPPORTED_COUNTRIES` — the
set the app can both name and price by ISO-2 code.

`FeesProvider` (`app/[id]/feesContext.tsx`) is handed the **whole fee table**
rather than one country's bands. It cannot price a second country the customer
picks client-side otherwise. This is safe: the provider is already documented as
display-only and the charge is recomputed server-side in `actions/payments.ts`
regardless. The table is 235 rows.

The summary's `deliveryShipping` line updates live as the country changes.

### 5. Error handling

| Case | Behaviour |
|---|---|
| Delivery country not in the fee table | `'*'` row — the deliberate worst-case fallback, consistent with existing policy |
| Delivery country == collection country | Arithmetically identical to today. Explicit regression test. |
| Pure return with a delivery address posted | Server ignores it. There is no outbound leg to price. |
| Partial delivery address | Reject the submission. Never merge fields across the two addresses. |
| Delivery country unresolvable at settlement | `createOrder` already refuses and alerts ops (`db/queries.ts:569`). That guard moves to the delivery country. |
| Delivery address set, exchange later cancelled | Columns are inert. Nothing reads them outside the exchange path. |

### 6. Testing

- `resolveFee` with split bands: ES collection + US delivery == 1796 cents.
- **Regression guard:** delivery bands == collection bands reproduces today's
  numbers for every country in the tariff.
- `checkoutLines` still sums exactly to the charged amount under split legs —
  the existing exact-sum check is what stops itemisation from changing the
  charge.
- SELF-booked exchange: `chargeCents == outboundLegCents` priced from the
  *delivery* zone.
- `createOrder` uses the delivery address for `shippingAddress` and the
  collection address for `billingAddress`.
- `updateData` rejects a partial delivery address, and ignores a delivery
  country on a pure-return basket.
- Migration is additive: existing rows read NULL and price unchanged.

## Known caveats

**1. The US outbound rate is too low.** €12.96 is derived faithfully from the
`$15.00` in `data/outbound-rates.csv`, which `scripts/tariff/outbound.mjs`
pulled from the store's Shopify delivery profile. The FX is correct — the same
0.864 USD→EUR ratio produces Mexico's €25.83 from `$29.90`. But a transatlantic
delivery priced below Australia (€15.27) and Japan (€18.94) is not credible;
the true figure is nearer €20.

This is a rate fix, not a code fix: correct the Shopify delivery profile,
re-run `outbound.mjs`, reseed. Until then Spain→US undercharges by roughly €7.
Deliberately out of scope — flagged 2026-09-02, deferred by the owner.

**2. `data/outbound-rates.csv` has `CA,Canada,29.9,CAD,5163`.** That is not an
FX conversion; CAD is not worth €1.73. It is the documented worst-case fallback
for a currency the store has never sold in (`7919d72`). Canada's €51.63 is a
placeholder, and a Canadian delivery address would be priced from it. Noted,
not addressed.

**3. `createOrder` hardcodes `shippingLines: "4.00 EUR / Estándar"` and
`currency: "EUR"`** on every exchange order regardless of destination
(`db/queries.ts:672`). Both become conspicuous once the destination is the US.
Neither affects what the customer is charged — the charge is the Stripe session
— so both are out of scope here, but they will look wrong on the Shopify order.

## Sequencing

The migration must land before the deploy that reads the columns, per this
repo's standing migration→deploy→seed order. No seed is required: the fee table
is unchanged.
