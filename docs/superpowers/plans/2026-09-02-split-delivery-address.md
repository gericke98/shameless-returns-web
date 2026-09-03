# Split Delivery Address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer exchanging a garment have the replacement delivered to a different address — including a different country — and charge the outbound leg at that country's rate.

**Architecture:** `orders` gains seven nullable `delivery_*` columns where NULL means "deliver to the collection address". `resolveFee` stops resolving both shipping legs from one country and takes a `FeeLegs` pair instead: the return leg from the collection zone, the outbound leg from the delivery zone. The collection address and its locked country are untouched, so carrier routing, customs and both settlement deductions are unaffected.

**Tech Stack:** Next.js App Router (server actions, `unstable_cache`), Drizzle ORM on Neon Postgres, Vitest, Shopify Admin GraphQL, Stripe Checkout.

**Spec:** `docs/superpowers/specs/2026-09-02-split-delivery-address-design.md`

## Global Constraints

- **Test command is not `npm test`.** The suite is non-deterministic under the default pool and fails a different subset each run. Always use:
  `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
  To run one file: `npx vitest run tests/<file> --pool=forks --poolOptions.forks.singleFork=true`
- **Money is integer cents.** Never chain arithmetic on euro floats. Convert with `centsToEuros` once, last.
- **Migration before deploy.** DDL is applied by hand against Neon before the code that reads the columns ships. No seed is required — `shipping_fees` is unchanged.
- **NULL `delivery_country` means "same as the collection address."** Never backfill it to a real value; the fallback is the feature.
- **The collection address keeps its locked country.** No task in this plan adds a `country` field to the existing address form or teaches `updateData` to write `shipping_country`.
- **Never transpose the two band lists.** `FeeLegs` is an object with named fields precisely so that `{collection, delivery}` cannot be swapped positionally. A swap is a silent money bug.
- Database: `ShamelessReturns` on Neon project `dry-firefly-81844312` (there are two databases on `main`; the other is wrong).
- Preview and production share one `DATABASE_URL`. Any manual QA writes to live customer orders.

---

### Task 1: Split `resolveFee` into two legs

The keystone. This task changes **no behaviour at all** — it is a provable refactor that gives `resolveFee` the shape the rest of the plan needs.

Today (`lib/fees.ts:93`) the exchange branch is:

```
outbound  = max(0, exchangeFeeCents - returnFeeCents)
returnLeg = exchangeFeeCents - outbound
feeCents  = exchangeFeeCents
```

The generalisation that preserves it exactly:

```
returnLeg = min(collection.exchangeFeeCents, collection.returnFeeCents)
outbound  = max(0, delivery.exchangeFeeCents - delivery.returnFeeCents)
feeCents  = returnLeg + outbound
```

When collection == delivery these agree for **every** input, including rows where `exchangeFee < returnFee` (which several existing tests use: `ES: flat(400, 0)`, `FR: flat(900, 600)`, `BANDED`). Verified exhaustively over 1849 combinations before this plan was written — do not "simplify" `min(exc, ret)` to `ret`, which breaks four existing tests.

**Files:**
- Modify: `lib/fees.ts:93-135` (`resolveFee`), plus new `FeeLegs` type and `sameZone` helper
- Modify (all **ten** production call sites, mechanical):
  - `app/[id]/components/secondWindowForm.tsx:43`
  - `app/[id]/components/summary/summary.tsx:94`
  - `app/[id]/windows/thirdWindow.tsx:190`
  - `app/[id]/windows/lastWindow.tsx:62`
  - `app/[id]/windows/orderWindowContent.tsx:20` (inside the module-level `calculatePrices` helper declared at line 14)
  - `app/[id]/windows/secondWindow.tsx:53`
  - `actions/return.ts:76`
  - `actions/payments.ts:60`
  - `scripts/verify-311749-fix.ts:300`
  - `scripts/audit-exchange-overcharges.ts:440`
- Test: `tests/fees.test.ts`, `tests/basketReturnPriceRounding.test.ts:95`

Get this list from the compiler, not from this plan — `npx tsc --noEmit` after the signature change enumerates every one. The list above was taken from `grep -rn "resolveFee(" --include='*.ts' --include='*.tsx' .` at the time of writing.

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `export type FeeLegs = { readonly collection: CountryBands; readonly delivery: CountryBands }`
  - `export function sameZone(bands: CountryBands): FeeLegs`
  - `export function resolveFee(legs: FeeLegs, basket: Basket): { feeCents: number; kind: FeeKind; returnLegCents: number; outboundLegCents: number }` — first parameter changed from `CountryBands` to `FeeLegs`

- [ ] **Step 1: Write the failing tests**

Add to `tests/fees.test.ts`, after the existing `describe("resolveFee — Rule A, by net amount", ...)` block:

```ts
describe("resolveFee — split legs", () => {
  // The real tariff rows for a 1 kg parcel (data/return-tariff.csv).
  const ES = [{ maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 500, exchangeFeeCents: 850 }];
  const US = [{ maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 2200, exchangeFeeCents: 3496 }];

  it("prices the return leg from the collection zone and the outbound leg from the delivery zone", () => {
    // Collected in Spain, replacement delivered to the US.
    expect(
      resolveFee({ collection: ES, delivery: US }, { hasItems: true, netAmount: 0, grams: 500 })
    ).toEqual({
      feeCents: 1796,
      kind: "exchange",
      returnLegCents: 500,
      outboundLegCents: 1296,
    });
  });

  it("is unchanged from the single-zone result when both zones are the same", () => {
    const legs = { collection: ES, delivery: ES };
    expect(resolveFee(legs, { hasItems: true, netAmount: 0, grams: 500 })).toEqual({
      feeCents: 850,
      kind: "exchange",
      returnLegCents: 500,
      outboundLegCents: 350,
    });
  });

  it("ignores the delivery zone entirely for a pure return", () => {
    // netAmount > 0 is a return: there is no replacement to deliver, so an
    // expensive delivery zone must not raise the price.
    const cheap = resolveFee({ collection: ES, delivery: ES }, { hasItems: true, netAmount: 40, grams: 500 });
    const dear = resolveFee({ collection: ES, delivery: US }, { hasItems: true, netAmount: 40, grams: 500 });
    expect(dear).toEqual(cheap);
    expect(dear.outboundLegCents).toBe(0);
  });

  it("selects each leg's weight band from its own zone", () => {
    // A 2.5 kg parcel: ES stays in its heavy band, US in its own.
    const esBands = [
      { maxGrams: 1000, returnFeeCents: 500, exchangeFeeCents: 850 },
      { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 900, exchangeFeeCents: 1250 },
    ];
    const usBands = [
      { maxGrams: 1000, returnFeeCents: 2200, exchangeFeeCents: 3496 },
      { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 13800, exchangeFeeCents: 15096 },
    ];
    expect(
      resolveFee({ collection: esBands, delivery: usBands }, { hasItems: true, netAmount: 0, grams: 2500 })
    ).toMatchObject({ returnLegCents: 900, outboundLegCents: 1296 });
  });

  it("clamps a delivery zone whose exchange fee is below its return fee", () => {
    // Not reachable from the seeded tariff, which asserts exchange > return,
    // but a hand-edited row must not produce a negative leg.
    const broken = [{ maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 900, exchangeFeeCents: 600 }];
    expect(
      resolveFee({ collection: ES, delivery: broken }, { hasItems: true, netAmount: 0, grams: 0 })
    ).toMatchObject({ outboundLegCents: 0, returnLegCents: 500, feeCents: 500 });
  });
});

describe("sameZone", () => {
  it("puts one band list on both legs", () => {
    const bands = TABLE.FR;
    expect(sameZone(bands)).toEqual({ collection: bands, delivery: bands });
  });
});
```

- [ ] **Step 2: Update the existing `resolveFee` tests to the new signature**

Every existing `resolveFee(x, basket)` in `tests/fees.test.ts` becomes `resolveFee(sameZone(x), basket)`. Their expected values do **not** change — that is the point of this task. Add `sameZone` to the import block at the top of the file:

```ts
import {
  DEFAULT_FEE_KEY,
  UNBOUNDED_MAX_GRAMS,
  centsToEuros,
  feesForCountry,
  feesForWeight,
  checkoutLines,
  resolveFee,
  sameZone,
  type FeeTable,
} from "@/lib/fees";
```

Apply the call-site rewrite:

```bash
sed -i '' 's/resolveFee(\(es\|BANDED\|TABLE\.[A-Z]*\), /resolveFee(sameZone(\1), /g' tests/fees.test.ts
grep -n "resolveFee(" tests/fees.test.ts
```

Inspect the `grep` output and hand-fix any call the `sed` missed (multi-line calls are not matched by it).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/fees.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `sameZone` is not exported from `@/lib/fees`, and the split-leg tests fail on the old single-argument shape.

- [ ] **Step 4: Implement the split**

In `lib/fees.ts`, add the type and helper next to the existing `CountryBands` declaration:

```ts
/**
 * The two journeys an exchange pays for, each priced in its own zone.
 *
 * `collection` is where the customer's parcel is picked up — the return leg,
 * and the only leg a pure return has. `delivery` is where the replacement is
 * sent. They are the same zone for almost every order, and `sameZone` is the
 * honest way to say so; they diverge when the customer asks for the
 * replacement to go somewhere else.
 *
 * Named fields, not a positional pair: transposing them would silently charge
 * a Spanish collection at a US rate and vice versa.
 */
export type FeeLegs = {
  readonly collection: CountryBands;
  readonly delivery: CountryBands;
};

/** Both legs in one zone — every order that has no separate delivery address. */
export function sameZone(bands: CountryBands): FeeLegs {
  return { collection: bands, delivery: bands };
}
```

Replace the body of `resolveFee`:

```ts
export function resolveFee(
  legs: FeeLegs,
  basket: Basket
): {
  feeCents: number;
  kind: FeeKind;
  /** The customer's parcel coming back. Always present when a fee applies. */
  returnLegCents: number;
  /** Delivering the replacement. Zero unless this is an exchange. */
  outboundLegCents: number;
} {
  if (!basket.hasItems) {
    return { feeCents: 0, kind: "none", returnLegCents: 0, outboundLegCents: 0 };
  }
  // Weight selects the band within each zone; Rule A then selects which of its
  // two fees applies. The two are independent — a heavier parcel does not
  // change whether this is a return or an exchange.
  const collection = feesForWeight(legs.collection, basket.grams);

  if (basket.netAmount > 0) {
    // A pure return has no second journey, so the delivery zone is not
    // consulted at all. A customer returning for a refund must not be charged
    // more because they once named an expensive delivery address.
    return {
      feeCents: collection.returnFeeCents,
      kind: "return",
      returnLegCents: collection.returnFeeCents,
      outboundLegCents: 0,
    };
  }

  // An exchange is two journeys in two possibly-different zones. Each leg is
  // priced where it happens: the parcel is collected from the collection zone
  // and the replacement is delivered into the delivery zone.
  //
  // Both expressions are exactly the single-zone formula this replaced, split
  // across two rows. With collection === delivery they reproduce it for every
  // input, including a row where the exchange fee is BELOW the return fee —
  // verified exhaustively. `min` rather than a bare `returnFeeCents` is what
  // preserves that case; do not "simplify" it.
  const delivery = feesForWeight(legs.delivery, basket.grams);
  const outboundLegCents = Math.max(
    0,
    delivery.exchangeFeeCents - delivery.returnFeeCents
  );
  const returnLegCents = Math.min(
    collection.exchangeFeeCents,
    collection.returnFeeCents
  );
  return {
    feeCents: returnLegCents + outboundLegCents,
    kind: "exchange",
    returnLegCents,
    outboundLegCents,
  };
}
```

- [ ] **Step 5: Update the ten production call sites**

Each becomes `sameZone(...)`. Behaviour is unchanged; later tasks replace `sameZone` with real legs where it matters. Add `sameZone` to the `@/lib/fees` import in each file.

In `app/[id]/components/summary/summary.tsx:94`:
```ts
  const { feeCents, returnLegCents, outboundLegCents } = resolveFee(
    sameZone(fees),
    basket
  );
```

In `app/[id]/windows/lastWindow.tsx:62`:
```ts
    const { feeCents, returnLegCents, outboundLegCents } = resolveFee(
      sameZone(fees),
      basket
    );
```

In `app/[id]/windows/secondWindow.tsx:53`:
```ts
  const { returnLegCents, outboundLegCents } = resolveFee(sameZone(fees), basket);
```

In `app/[id]/components/secondWindowForm.tsx:43`:
```ts
  const { feeCents } = resolveFee(sameZone(fees), basket);
```

In `actions/payments.ts:60`:
```ts
  const { feeCents, returnLegCents, outboundLegCents } = resolveFee(
    sameZone(fees),
    basket
  );
```

In `actions/return.ts:76`:
```ts
  const { returnLegCents } = resolveFee(sameZone(fees), basket);
```

In `app/[id]/windows/thirdWindow.tsx:190`:
```ts
    const { feeCents } = resolveFee(sameZone(fees), {
```

In `app/[id]/windows/orderWindowContent.tsx:14-20` the bands arrive as a parameter, so the helper's signature changes rather than its call:
```ts
const calculatePrices = (
  items: OrderItem[],
  allProducts: Product[],
  legs: FeeLegs
): Prices => {
  const basket = valueBasket(items, allProducts);
  const { feeCents } = resolveFee(legs, basket);
```

Only the third parameter changes: `fees: CountryBands` becomes `legs: FeeLegs`. Swap the `CountryBands` import for `FeeLegs` — `CountryBands` is not used elsewhere in that file.
and its caller at line 44 becomes `calculatePrices(items, allProducts, sameZone(fees))`. Import `type FeeLegs` alongside `sameZone`.

In `scripts/verify-311749-fix.ts:300`:
```ts
  const { feeCents, kind, returnLegCents, outboundLegCents } = resolveFee(
    sameZone(bands),
    result
  );
```

In `scripts/audit-exchange-overcharges.ts:440`:
```ts
    const fee = resolveFee(sameZone(bands), basket);
```

Also update `tests/basketReturnPriceRounding.test.ts:95`:
```ts
    const fee = resolveFee(sameZone(bands), basket);
```
(add `sameZone` to its `@/lib/fees` import).

- [ ] **Step 6: Run the full suite to verify nothing changed**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS. Every pre-existing assertion holds with its original expected value. If any pre-existing fee assertion changed, the formula is wrong — do not edit the assertion to match.

Run: `npx tsc --noEmit`
Expected: no errors. If a call site was missed, this is where it surfaces.

- [ ] **Step 7: Commit**

```bash
git add lib/fees.ts tests/fees.test.ts app/ actions/ scripts/verify-311749-fix.ts
git commit -m "refactor: price each shipping leg in its own zone

resolveFee derived both legs of an exchange from one country's row, which is
correct only while the parcel is collected from and delivered to the same
place. It now takes a FeeLegs pair.

No behaviour change. The new expressions reproduce the old ones for every
input when both legs carry the same bands, including rows where the exchange
fee is below the return fee -- min(exc, ret) rather than a bare ret is what
preserves that, verified exhaustively over the whole space the tests use.
Every call site passes sameZone() and every existing assertion holds with its
original value.

FeeLegs has named fields so the two lists cannot be transposed positionally,
which would silently charge one country's collection at another's rate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 2: The `delivery_*` columns and their fallback

**Files:**
- Modify: `db/schema.ts:14-45` (the `orders` table)
- Create: `drizzle/0002_delivery_address.sql`
- Create: `lib/deliveryAddress.ts`
- Test: `tests/deliveryAddress.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `export type DeliveryAddress = { name: string; address1: string; address2: string | null; zip: string; city: string; province: string | null; country: string }`
  - `export function hasSeparateDelivery(order: OrderAddressFields): boolean`
  - `export function deliveryAddressOf(order: OrderAddressFields): DeliveryAddress` — returns the collection address when no separate one is set
  - `export type OrderAddressFields` — the structural subset of `typeof orders.$inferSelect` these read

- [ ] **Step 1: Write the failing test**

Create `tests/deliveryAddress.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deliveryAddressOf, hasSeparateDelivery } from "@/lib/deliveryAddress";

/** An order as `orders` stores it. Country is a display NAME, not a code. */
function order(over: Record<string, unknown> = {}) {
  return {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: "3B",
    shippingZip: "28013",
    shippingCity: "Madrid",
    shippingProvince: "Madrid",
    shippingCountry: "España",
    deliveryName: null,
    deliveryAddress1: null,
    deliveryAddress2: null,
    deliveryZip: null,
    deliveryCity: null,
    deliveryProvince: null,
    deliveryCountry: null,
    ...over,
  } as any;
}

const US_DELIVERY = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: "Apt 4",
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

describe("hasSeparateDelivery", () => {
  it("is false when no delivery address is stored", () => {
    expect(hasSeparateDelivery(order())).toBe(false);
  });

  it("is true when a delivery address is stored", () => {
    expect(hasSeparateDelivery(order(US_DELIVERY))).toBe(true);
  });

  // The country and the street are what make an address deliverable and
  // priceable. A row carrying only a stray province is corrupt, not separate.
  it("is false when the country is set but the street is not", () => {
    expect(hasSeparateDelivery(order({ deliveryCountry: "US" }))).toBe(false);
  });

  it("is false when the street is set but the country is not", () => {
    expect(hasSeparateDelivery(order({ deliveryAddress1: "120 Broadway" }))).toBe(false);
  });
});

describe("deliveryAddressOf", () => {
  it("falls back to the collection address when none is stored", () => {
    expect(deliveryAddressOf(order())).toEqual({
      name: "Ana Ruiz",
      address1: "Calle Mayor 1",
      address2: "3B",
      zip: "28013",
      city: "Madrid",
      province: "Madrid",
      country: "España",
    });
  });

  it("returns the stored delivery address when there is one", () => {
    expect(deliveryAddressOf(order(US_DELIVERY))).toEqual({
      name: "Ana Ruiz",
      address1: "120 Broadway",
      address2: "Apt 4",
      zip: "10271",
      city: "New York",
      province: "NY",
      country: "US",
    });
  });

  // All-or-nothing. Merging the two addresses is how a Spanish city ends up
  // filed under a US postcode.
  it("never mixes fields from the two addresses", () => {
    const partial = order({ ...US_DELIVERY, deliveryCity: null });
    expect(deliveryAddressOf(partial).city).toBe("Madrid");
    expect(deliveryAddressOf(partial).country).toBe("España");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/deliveryAddress.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `@/lib/deliveryAddress`.

- [ ] **Step 3: Add the columns to the schema**

In `db/schema.ts`, immediately after `shippingPhone` in the `orders` table:

```ts
  // Where the REPLACEMENT goes, when that is not where the parcel came from.
  //
  // All seven are null for almost every order and null is the whole feature:
  // it means "deliver to the collection address above", so every row that
  // predates this reads and prices exactly as it did before. They are never
  // backfilled.
  //
  // These do NOT affect the return leg. The parcel is still collected from
  // shipping_*, which still picks the carrier lane and the customs
  // declaration; only the outbound leg and the exchange order's destination
  // read these.
  deliveryName: text("delivery_name"),
  deliveryAddress1: text("delivery_address1"),
  deliveryAddress2: text("delivery_address2"),
  deliveryZip: text("delivery_zip"),
  deliveryCity: text("delivery_city"),
  deliveryProvince: text("delivery_province"),
  // A display NAME or an ISO-2 code, same as shipping_country — normalizeCountry
  // resolves either.
  deliveryCountry: text("delivery_country"),
```

- [ ] **Step 4: Write the migration**

Create `drizzle/0002_delivery_address.sql`:

```sql
-- Where the replacement goes, when that is not where the parcel came from.
--
-- All seven nullable, and null is load-bearing: it means "deliver to the
-- collection address", so every existing row keeps its current destination
-- and its current price with no backfill. Additive and reversible.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_name" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_address1" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_address2" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_zip" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_city" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_province" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_country" text;
```

- [ ] **Step 5: Write the implementation**

Create `lib/deliveryAddress.ts`:

```ts
// Which address the REPLACEMENT is delivered to.
//
// Pure module: no db, no env, no server-only imports, so client components can
// resolve the same address and zone the server charges from.
//
// The rule is all-or-nothing. A delivery address is either complete enough to
// use in full, or it does not exist and the collection address is used in
// full. There is deliberately no field-by-field fallback: merging the two is
// how a Spanish city ends up filed under a US postcode, which is the exact
// shape of the bug that sent four exchange orders to the wrong country
// (759bb1b).

/** The structural subset of `orders` these functions read. */
export type OrderAddressFields = {
  shippingName: string;
  shippingAddress1: string;
  shippingAddress2: string | null;
  shippingZip: string;
  shippingCity: string;
  shippingProvince: string | null;
  shippingCountry: string;
  deliveryName: string | null;
  deliveryAddress1: string | null;
  deliveryAddress2: string | null;
  deliveryZip: string | null;
  deliveryCity: string | null;
  deliveryProvince: string | null;
  deliveryCountry: string | null;
};

export type DeliveryAddress = {
  readonly name: string;
  readonly address1: string;
  readonly address2: string | null;
  readonly zip: string;
  readonly city: string;
  readonly province: string | null;
  readonly country: string;
};

const filled = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Whether this order carries a delivery address of its own.
 *
 * Requires every field that makes an address both deliverable and priceable:
 * name, street, postcode, city and country. `address2` and `province` are
 * genuinely optional — plenty of real addresses have neither, and `province`
 * is only ever sent to Shopify for Spain.
 *
 * A row with some of these but not all is corrupt rather than separate, and
 * is treated as absent. `updateData` rejects partial writes, so the only way
 * to produce one is a hand-edit in the database.
 */
export function hasSeparateDelivery(order: OrderAddressFields): boolean {
  return (
    filled(order.deliveryName) &&
    filled(order.deliveryAddress1) &&
    filled(order.deliveryZip) &&
    filled(order.deliveryCity) &&
    filled(order.deliveryCountry)
  );
}

/** The address the replacement ships to — the collection address unless a
 *  complete separate one is stored. */
export function deliveryAddressOf(order: OrderAddressFields): DeliveryAddress {
  if (!hasSeparateDelivery(order)) {
    return {
      name: order.shippingName,
      address1: order.shippingAddress1,
      address2: order.shippingAddress2,
      zip: order.shippingZip,
      city: order.shippingCity,
      province: order.shippingProvince,
      country: order.shippingCountry,
    };
  }
  return {
    name: order.deliveryName!,
    address1: order.deliveryAddress1!,
    address2: order.deliveryAddress2,
    zip: order.deliveryZip!,
    city: order.deliveryCity!,
    province: order.deliveryProvince,
    country: order.deliveryCountry!,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/deliveryAddress.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (10 tests)

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Apply the migration to Neon**

Against database `ShamelessReturns` on project `dry-firefly-81844312`. This is DDL on the production database and must land before any deploy that reads the columns. `ADD COLUMN IF NOT EXISTS` on a nullable column takes no table rewrite and no lock of consequence.

Verify afterwards:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'orders' AND column_name LIKE 'delivery_%'
ORDER BY column_name;
```
Expected: 7 rows.

- [ ] **Step 8: Commit**

```bash
git add db/schema.ts drizzle/0002_delivery_address.sql lib/deliveryAddress.ts tests/deliveryAddress.test.ts
git commit -m "feat: store a separate delivery address for the replacement

Seven nullable delivery_* columns on orders. Null means 'deliver to the
collection address', so every existing row keeps its destination and its price
with no backfill.

deliveryAddressOf resolves all-or-nothing. There is no field-by-field
fallback: merging the two addresses is how a Spanish city ends up under a US
postcode, which is the shape of the bug that sent four exchange orders to the
wrong country (759bb1b).

Nothing reads these yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 3: Resolve both legs from an order

One place that turns an order plus the fee table into a `FeeLegs`, so the four servers and the client cannot disagree about it.

**Files:**
- Create: `lib/feeLegs.ts`
- Test: `tests/feeLegs.test.ts`

**Interfaces:**
- Consumes: `FeeLegs`, `feesForCountry` (Task 1); `deliveryAddressOf`, `OrderAddressFields` (Task 2)
- Produces: `export function feeLegsForOrder(table: FeeTable, order: OrderAddressFields | null | undefined): FeeLegs`

- [ ] **Step 1: Write the failing test**

Create `tests/feeLegs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];

const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  "ES-CN": flat(2115, 3415),
  US: flat(2200, 3496),
};

function order(over: Record<string, unknown> = {}) {
  return {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: null,
    shippingZip: "28013",
    shippingCity: "Madrid",
    shippingProvince: "Madrid",
    shippingCountry: "España",
    deliveryName: null,
    deliveryAddress1: null,
    deliveryAddress2: null,
    deliveryZip: null,
    deliveryCity: null,
    deliveryProvince: null,
    deliveryCountry: null,
    ...over,
  } as any;
}

const US_DELIVERY = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: null,
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

describe("feeLegsForOrder", () => {
  it("puts the collection zone on both legs when there is no delivery address", () => {
    expect(feeLegsForOrder(TABLE, order())).toEqual({
      collection: flat(500, 850),
      delivery: flat(500, 850),
    });
  });

  it("prices the delivery leg in the delivery country", () => {
    expect(feeLegsForOrder(TABLE, order(US_DELIVERY))).toEqual({
      collection: flat(500, 850),
      delivery: flat(2200, 3496),
    });
  });

  // The collection leg keeps resolveZone's Spanish sub-zone logic: the parcel
  // is still collected from the Canaries whatever the replacement's
  // destination.
  it("keeps the Spanish sub-zone on the collection leg", () => {
    const legs = feeLegsForOrder(
      TABLE,
      order({ ...US_DELIVERY, shippingZip: "38001" })
    );
    expect(legs.collection).toEqual(flat(2115, 3415));
    expect(legs.delivery).toEqual(flat(2200, 3496));
  });

  // A Spanish DELIVERY address gets the same sub-zone treatment, because
  // resolveZone reads the delivery postcode for that leg.
  it("applies the Spanish sub-zone to a Spanish delivery address", () => {
    const legs = feeLegsForOrder(
      TABLE,
      order({
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "Calle del Mar 2",
        deliveryZip: "38001",
        deliveryCity: "Santa Cruz de Tenerife",
        deliveryCountry: "España",
      })
    );
    expect(legs.collection).toEqual(flat(500, 850));
    expect(legs.delivery).toEqual(flat(2115, 3415));
  });

  it("falls back to the default row for a country with no rows", () => {
    const legs = feeLegsForOrder(
      TABLE,
      order({
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "1 Queen St",
        deliveryZip: "1010",
        deliveryCity: "Auckland",
        deliveryCountry: "New Zealand",
      })
    );
    expect(legs.delivery).toEqual(flat(9900, 12000));
  });

  it("puts the default row on both legs for a missing order", () => {
    expect(feeLegsForOrder(TABLE, null)).toEqual({
      collection: flat(9900, 12000),
      delivery: flat(9900, 12000),
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/feeLegs.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `@/lib/feeLegs`.

- [ ] **Step 3: Write the implementation**

Create `lib/feeLegs.ts`:

```ts
// Turn an order into the two band lists its two shipping legs are priced from.
//
// One place, because five call sites need this pair and a disagreement between
// any two of them is a customer charged one number and settled at another.
// Pure: no db, no env, so the portal resolves the same legs the Stripe charge
// is computed from.
import { feesForCountry, type FeeLegs, type FeeTable } from "./fees";
import { resolveZone } from "./zones";
import { deliveryAddressOf, type OrderAddressFields } from "./deliveryAddress";

/**
 * `collection` is priced from `shipping_country` + `shipping_zip` — where the
 * carrier picks the parcel up, which is what it charges for. `delivery` is
 * priced from the delivery address, which is the collection address unless the
 * customer named a different one.
 *
 * Both go through `resolveZone`, so a Spanish address on either leg gets its
 * island or enclave rate rather than the peninsular one.
 *
 * A null order resolves both legs to the '*' row, which is the dearest —
 * the same worst-case principle `feesForCountry` already applies. Callers on
 * that path have bigger problems than the fee, but they must not get a free
 * one.
 */
export function feeLegsForOrder(
  table: FeeTable,
  order: OrderAddressFields | null | undefined
): FeeLegs {
  if (!order) {
    const fallback = feesForCountry(table, null);
    return { collection: fallback, delivery: fallback };
  }
  const delivery = deliveryAddressOf(order);
  return {
    collection: feesForCountry(
      table,
      resolveZone(order.shippingCountry, order.shippingZip)
    ),
    delivery: feesForCountry(table, resolveZone(delivery.country, delivery.zip)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/feeLegs.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/feeLegs.ts tests/feeLegs.test.ts
git commit -m "feat: resolve both fee legs from one order

Five call sites need the (collection, delivery) band pair and a disagreement
between any two of them is a customer charged one number and settled at
another. One function, pure, so the portal resolves the same legs the Stripe
charge uses.

Both legs go through resolveZone, so a Spanish address on either one gets its
island or enclave rate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 4: Charge the delivery zone for the outbound leg

**Files:**
- Modify: `actions/payments.ts:54-70`
- Modify: `actions/return.ts:70-78`
- Test: `tests/deliveryLegCharge.test.ts`

**Interfaces:**
- Consumes: `feeLegsForOrder` (Task 3), `resolveFee` (Task 1)
- Produces: no new exports — `createStripeUrl` now charges the delivery zone's outbound leg

- [ ] **Step 1: Write the failing test**

Create `tests/deliveryLegCharge.test.ts`. It exercises the arithmetic `createStripeUrl` performs, over the real tariff rows, without standing up Stripe:

```ts
import { describe, expect, it } from "vitest";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { centsToEuros, resolveFee, DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];

/** The real 1 kg rows from data/return-tariff.csv. */
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  US: flat(2200, 3496),
};

function order(over: Record<string, unknown> = {}) {
  return {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: null,
    shippingZip: "28013",
    shippingCity: "Madrid",
    shippingProvince: "Madrid",
    shippingCountry: "España",
    deliveryName: null,
    deliveryAddress1: null,
    deliveryAddress2: null,
    deliveryZip: null,
    deliveryCity: null,
    deliveryProvince: null,
    deliveryCountry: null,
    ...over,
  } as any;
}

const US_DELIVERY = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: null,
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

/** An even swap: same price in, same price out. */
const evenSwap = { hasItems: true, netAmount: 0, grams: 500 };

describe("the charge for a Spain-collected exchange", () => {
  it("is the Spanish exchange fee when the replacement stays in Spain", () => {
    const legs = feeLegsForOrder(TABLE, order());
    expect(resolveFee(legs, evenSwap).feeCents).toBe(850);
  });

  it("adds the US outbound leg when the replacement goes to the US", () => {
    const legs = feeLegsForOrder(TABLE, order(US_DELIVERY));
    const { feeCents, returnLegCents, outboundLegCents } = resolveFee(legs, evenSwap);
    // Collected in Spain at 5.00, delivered to the US at 12.96.
    expect(returnLegCents).toBe(500);
    expect(outboundLegCents).toBe(1296);
    expect(feeCents).toBe(1796);
    expect(centsToEuros(feeCents)).toBe(17.96);
  });

  // The SELF rule is a subtraction, not a second table: a self-booked return
  // pays its own courier for the return leg, but the replacement still travels
  // on our account — now to the US.
  it("bills a self-booked return the US outbound leg alone", () => {
    const legs = feeLegsForOrder(TABLE, order(US_DELIVERY));
    const { outboundLegCents } = resolveFee(legs, evenSwap);
    expect(outboundLegCents).toBe(1296);
  });

  // A pure return has no second journey. A stale delivery address left on the
  // row must not raise the price of a refund.
  it("does not charge the delivery zone on a pure return", () => {
    const legs = feeLegsForOrder(TABLE, order(US_DELIVERY));
    const pureReturn = { hasItems: true, netAmount: 40, grams: 500 };
    expect(resolveFee(legs, pureReturn)).toMatchObject({
      kind: "return",
      feeCents: 500,
      outboundLegCents: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/deliveryLegCharge.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS already — this file exercises Tasks 1 and 3, which are done. It is the regression net for the edits in Steps 3 and 4. If it fails, Task 1 or Task 3 is wrong; fix that before continuing.

- [ ] **Step 3: Charge the delivery zone in `actions/payments.ts`**

Replace lines 54-60 (the `feesForCountry` / `resolveFee` pair):

```ts
  const feeTable = await getFeeTable();
  // Two legs, two zones. The parcel is collected from `order.shipping*` and the
  // replacement is delivered to the delivery address, which is the same place
  // unless the customer named a different one. Before this, both were priced
  // from the collection country: a Spain-collected exchange delivered to the
  // US was charged Spain's 8.50 for a journey costing 5.00 + 12.96.
  const legs = feeLegsForOrder(feeTable, order);
  const { feeCents, returnLegCents, outboundLegCents } = resolveFee(legs, basket);
```

Update the imports at the top of the file: drop `feesForCountry` and `sameZone` if they are now unused, drop `resolveZone` if unused, and add:
```ts
import { feeLegsForOrder } from "@/lib/feeLegs";
```

- [ ] **Step 4: Charge the delivery zone in `actions/return.ts`**

Replace lines 70-76:

```ts
  const feeTable = await getFeeTable();
  // Only `returnLegCents` is read here — the return method is a decision about
  // the parcel coming back, not about where the replacement goes — but the real
  // legs are passed rather than sameZone so that a later reader of
  // `outboundLegCents` on this path gets the truth rather than a plausible
  // wrong number.
  const legs = feeLegsForOrder(feeTable, order);
  const { returnLegCents } = resolveFee(legs, basket);
```

Update the imports the same way, adding `import { feeLegsForOrder } from "@/lib/feeLegs";`.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS. Pay particular attention to `tests/returnPresentmentCurrency.test.ts`, `tests/selfBookedFee.test.ts`, `tests/selfBookedRouting.test.ts` and `tests/selfBookedSettlement.test.ts` — they exercise these two files.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add actions/payments.ts actions/return.ts tests/deliveryLegCharge.test.ts
git commit -m "feat: charge the outbound leg in the delivery country

createStripeUrl priced both legs of an exchange from the collection country.
A parcel collected in Spain with the replacement delivered to the US was
charged Spain's 8.50 for a journey that costs 5.00 to collect and 12.96 to
deliver.

Only the Stripe charge reads the outbound leg. Both settlement deductions
(settleReturn's gift-card and refund lanes) and the fee declared to Shopify's
returnCreate are return-leg-only, so the delivery country cannot desync the
charge from the settlement.

A pure return still ignores the delivery zone entirely: there is no second
journey, and a stale delivery address must not raise the price of a refund.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 5: Ship the exchange order to the delivery address

**Files:**
- Modify: `db/queries.ts:555-700` (`createOrder`)
- Test: `tests/exchangeOrderAddress.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `deliveryAddressOf` (Task 2)
- Produces: no new exports

- [ ] **Step 1: Write the failing tests**

Append to `tests/exchangeOrderAddress.test.ts`, inside the existing top-level `describe` (reuse that file's `order()`, `stubShopify()`, `sent` and `alerts` helpers — read them first; they are defined at the top of the file):

```ts
describe("a separate delivery address", () => {
  const US_DELIVERY = {
    deliveryName: "Ana Ruiz",
    deliveryAddress1: "120 Broadway",
    deliveryAddress2: "Apt 4",
    deliveryZip: "10271",
    deliveryCity: "New York",
    deliveryProvince: "NY",
    deliveryCountry: "United States",
  };

  /** The helper's defaults are Belgian; spell out the Spanish collection
   *  address wherever a test asserts on it. */
  const SPANISH_COLLECTION = {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: "3B",
    shippingCity: "Madrid",
    shippingProvince: "Madrid",
    shippingZip: "28013",
    shippingCountry: "España",
  };

  it("ships to the delivery address and bills to the collection address", async () => {
    stubShopify();
    const { createOrder } = await import("@/db/queries");
    await createOrder(
      order({ ...SPANISH_COLLECTION, ...US_DELIVERY }),
      [{ new_variant_id: "gid://shopify/ProductVariant/1" }]
    );

    const input = sent[0].variables.order;
    expect(input.shippingAddress).toMatchObject({
      address1: "120 Broadway",
      city: "New York",
      countryCode: "US",
      zip: "10271",
    });
    // The card was charged where the customer lives, which is where they were
    // billed originally.
    expect(input.billingAddress).toMatchObject({
      address1: "Calle Mayor 1",
      city: "Madrid",
      countryCode: "ES",
      zip: "28013",
    });
  });

  // The province is Spanish-only and getProvinceCode returns its INPUT
  // UNCHANGED when nothing matches. Reading the delivery country against the
  // collection city is how "Woluwe-Saint-Pierre" reached Shopify as a province
  // code (759bb1b); the two halves have to move together.
  it("omits provinceCode on a non-Spanish delivery address", async () => {
    stubShopify();
    const { createOrder } = await import("@/db/queries");
    await createOrder(
      order({ ...SPANISH_COLLECTION, ...US_DELIVERY }),
      [{ new_variant_id: "gid://shopify/ProductVariant/1" }]
    );
    expect(sent[0].variables.order.shippingAddress.provinceCode).toBeUndefined();
  });

  it("derives provinceCode from the DELIVERY province for a Spanish delivery address", async () => {
    stubShopify();
    const { createOrder } = await import("@/db/queries");
    await createOrder(
      order({
        shippingCountry: "United States",
        shippingProvince: "NY",
        shippingCity: "New York",
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "Calle Mayor 1",
        deliveryZip: "28013",
        deliveryCity: "Madrid",
        deliveryProvince: "Madrid",
        deliveryCountry: "España",
      }),
      [{ new_variant_id: "gid://shopify/ProductVariant/1" }]
    );
    const shipping = sent[0].variables.order.shippingAddress;
    expect(shipping.countryCode).toBe("ES");
    // Whatever getProvinceCode maps "Madrid" to, it must not be "NY" and must
    // not be undefined — the point is that it read the delivery address.
    expect(shipping.provinceCode).toBeDefined();
    expect(shipping.provinceCode).not.toBe("NY");
  });

  it("refuses and alerts when the delivery country cannot be resolved", async () => {
    stubShopify();
    const { createOrder } = await import("@/db/queries");
    const result = await createOrder(
      order({
        shippingCountry: "España",
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "1 Nowhere St",
        deliveryZip: "0000",
        deliveryCity: "Nowhere",
        deliveryCountry: "Freedonia",
      }),
      [{ new_variant_id: "gid://shopify/ProductVariant/1" }]
    );
    expect(result).toMatchObject({ success: false });
    expect(sent).toHaveLength(0);
    expect(alerts.join("\n")).toContain("EXCHANGE NOT CREATED");
  });

  it("still ships to the collection address when no delivery address is set", async () => {
    stubShopify();
    const { createOrder } = await import("@/db/queries");
    await createOrder(
      order({ shippingCountry: "Portugal", shippingCity: "Lisboa", shippingZip: "1100-148" }),
      [{ new_variant_id: "gid://shopify/ProductVariant/1" }]
    );
    expect(sent[0].variables.order.shippingAddress).toMatchObject({
      city: "Lisboa",
      countryCode: "PT",
      zip: "1100-148",
    });
  });
});
```

That file's `order()` helper does not define the seven `delivery_*` keys — it ends at `shippingPhone`. Add them as `null` defaults, before the `...over` spread, so these tests override cleanly and every pre-existing test in the file keeps exercising the no-delivery-address path:

```ts
    shippingPhone: "0470678370",
    deliveryName: null,
    deliveryAddress1: null,
    deliveryAddress2: null,
    deliveryZip: null,
    deliveryCity: null,
    deliveryProvince: null,
    deliveryCountry: null,
    ...over,
```

Note its defaults are Belgian (`Woluwe-Saint-Pierre`, `1150`, `"Belgium"`), not the Spanish ones the new tests assume — so each new test above passes its own `shipping*` overrides explicitly. Keep doing that rather than changing the helper's defaults, which the existing tests depend on.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/exchangeOrderAddress.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `shippingAddress` still carries the collection address, so `address1` is `"Calle Mayor 1"` where `"120 Broadway"` is expected.

- [ ] **Step 3: Read the delivery address in `createOrder`**

In `db/queries.ts`, replace the `countryCode` / `provinceCode` derivation (lines 569-600) with:

```ts
  // The billing address stays with the collection address — that is where the
  // customer lives and where they were billed originally. Only the SHIPPING
  // address follows the replacement, which may be another country entirely.
  const delivery = deliveryAddressOf(order);

  // The customer's OWN country, not the shop's.
  //
  // This was hardcoded to "ES" in both addresses below. We store the country as
  // a display NAME ("Belgium", "Portugal") and Shopify wants an ISO-2 code, so
  // whoever wrote it had a name, needed a code, and typed the shop's own.
  // Measured 2026-08-26: 4 of 195 exchange orders shipped under the wrong
  // country — #311370, #311687, #311688, #311689 — three of them in one day.
  //
  // The zips were never wrong. A four-digit Belgian zip filed under Spain just
  // READS as a broken Spanish postcode, which is why this looked like a zip bug.
  const countryCode = normalizeCountry(delivery.country);
  const billingCountryCode = normalizeCountry(order.shippingCountry);
  if (!countryCode || !billingCountryCode) {
    // Refuse rather than guess. Defaulting to the shop's own country is exactly
    // what shipped those four parcels to Spain, and a parcel sent to the wrong
    // nation is worse than an exchange that visibly did not happen: returning
    // failure leaves the line unsettled and still visible in the dashboard.
    console.error(
      `createOrder: cannot resolve country (delivery ${JSON.stringify(delivery.country)}, billing ${JSON.stringify(order.shippingCountry)}) for order ${order.orderNumber} — refusing to create the exchange`
    );
    await alertOps(
      `[returns] EXCHANGE NOT CREATED — unresolvable country on ${order.orderNumber}`,
      [
        `The exchange order for ${order.orderNumber} was not created because we could not resolve its country to an ISO-2 code.`,
        `Delivery country: ${JSON.stringify(delivery.country)}`,
        `Billing country:  ${JSON.stringify(order.shippingCountry)}`,
        `Nothing was charged and no parcel was booked. The return line is still unsettled in the dashboard.`,
        `Fix by correcting the country on the order, or by adding it to lib/countries.ts, then settling the return again.`,
      ].join("\n")
    );
    return { success: false, error: "Unresolvable shipping country" };
  }

  // Province codes are Spanish-only: SPANISH_PROVINCE_CODES is the whole table,
  // and getProvinceCode returns its INPUT UNCHANGED when nothing matches. With
  // the province field blank the city was passed in instead, so order #311687
  // sent "Woluwe-Saint-Pierre" — a Belgian city — as a province code. Omit the
  // field abroad rather than send a value we cannot map.
  //
  // Both halves read the DELIVERY address, and they must move together: testing
  // the delivery country against the collection city would reintroduce that bug
  // from the other side.
  const provinceCode =
    countryCode === "ES"
      ? delivery.province
        ? getProvinceCode(delivery.province)
        : getProvinceCode(delivery.city)
      : undefined;

  // Same rule, applied independently to the billing address, which does not
  // move.
  const billingProvinceCode =
    billingCountryCode === "ES"
      ? order.shippingProvince
        ? getProvinceCode(order.shippingProvince)
        : getProvinceCode(order.shippingCity)
      : undefined;
```

Add the import at the top of `db/queries.ts`:
```ts
import { deliveryAddressOf } from "@/lib/deliveryAddress";
```

- [ ] **Step 4: Point the two address blocks at the right sources**

In the `variables.order` object, `billingAddress` becomes:

```ts
      billingAddress: {
        address1: order.shippingAddress1,
        address2: order.shippingAddress2 || "",
        city: order.shippingCity,
        countryCode: billingCountryCode,
        firstName: order.shippingName || "Return",
        lastName: order.lastName || "Return",
        phone: order.shippingPhone || "+34608667749",
        provinceCode: billingProvinceCode,
        zip: order.shippingZip,
      },
```

and `shippingAddress` becomes:

```ts
      shippingAddress: {
        address1: delivery.address1,
        address2: delivery.address2 || "",
        city: delivery.city,
        countryCode,
        firstName: delivery.name || "Return",
        lastName: order.lastName || "Return",
        phone: order.shippingPhone || "+34608667749",
        provinceCode: provinceCode,
        zip: delivery.zip,
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/exchangeOrderAddress.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS — the pre-existing tests in that file included, unchanged.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add db/queries.ts tests/exchangeOrderAddress.test.ts
git commit -m "feat: ship the exchange order to the delivery address

The exchange order's shippingAddress now follows the replacement; its
billingAddress stays with the collection address, where the customer lives and
was billed originally.

provinceCode moves with it, both halves together. It is Spanish-only and
getProvinceCode returns its input unchanged when nothing matches, so testing
the delivery country against the collection city would reintroduce the
Woluwe-Saint-Pierre bug (759bb1b) from the other side. The billing address
gets the same rule applied independently.

The unresolvable-country guard now covers both addresses and names which one
failed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 6: Persist the delivery address from the form

**Files:**
- Modify: `actions/updateOrder.ts:36-75` (`FormDataFields`, `parseFormData`), `actions/updateOrder.ts:165-207` (`updateData`)
- Create: `lib/deliveryAddressInput.ts`
- Test: `tests/deliveryAddressInput.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_COUNTRIES`, `normalizeCountry` from `@/lib/countries`
- Produces:
  - `export type DeliveryInput = { name: string; address1: string; address2: string | null; zip: string; city: string; province: string | null; country: string }`
  - `export type DeliveryParse = { ok: true; value: DeliveryInput | null } | { ok: false; reason: "partial" | "unsupported-country" }`
  - `export function parseDeliveryInput(fields: Record<string, string | undefined>): DeliveryParse`

- [ ] **Step 1: Write the failing test**

Create `tests/deliveryAddressInput.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";

const COMPLETE = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: "Apt 4",
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

describe("parseDeliveryInput", () => {
  it("returns null when the block is absent entirely", () => {
    expect(parseDeliveryInput({})).toEqual({ ok: true, value: null });
  });

  it("returns null when every field is blank", () => {
    expect(
      parseDeliveryInput({ deliveryName: "", deliveryAddress1: "  ", deliveryCountry: "" })
    ).toEqual({ ok: true, value: null });
  });

  it("accepts a complete block", () => {
    expect(parseDeliveryInput(COMPLETE)).toEqual({
      ok: true,
      value: {
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: "Apt 4",
        zip: "10271",
        city: "New York",
        province: "NY",
        country: "US",
      },
    });
  });

  it("treats address2 and province as genuinely optional", () => {
    const { deliveryAddress2, deliveryProvince, ...rest } = COMPLETE;
    expect(parseDeliveryInput(rest)).toEqual({
      ok: true,
      value: {
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: null,
        zip: "10271",
        city: "New York",
        province: null,
        country: "US",
      },
    });
  });

  // All-or-nothing. Half an address must not be written, because
  // deliveryAddressOf would then silently fall back to the collection address
  // and the customer would be told their replacement is going somewhere it is
  // not.
  it("rejects a partial block", () => {
    const { deliveryCity, ...partial } = COMPLETE;
    expect(parseDeliveryInput(partial)).toEqual({ ok: false, reason: "partial" });
  });

  it("rejects a blank required field as partial", () => {
    expect(parseDeliveryInput({ ...COMPLETE, deliveryZip: "   " })).toEqual({
      ok: false,
      reason: "partial",
    });
  });

  // The country is the one field that sets the price, so it is the one field
  // that cannot be free text. Anything outside SUPPORTED_COUNTRIES is refused
  // rather than silently priced from the '*' row.
  it("rejects a country outside SUPPORTED_COUNTRIES", () => {
    expect(parseDeliveryInput({ ...COMPLETE, deliveryCountry: "Freedonia" })).toEqual({
      ok: false,
      reason: "unsupported-country",
    });
  });

  it("normalises a country name to its ISO-2 code", () => {
    const parsed = parseDeliveryInput({ ...COMPLETE, deliveryCountry: "Estados Unidos" });
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.value?.country).toBe("US");
  });

  it("trims surrounding whitespace", () => {
    const parsed = parseDeliveryInput({ ...COMPLETE, deliveryCity: "  New York  " });
    expect(parsed.ok && parsed.value?.city).toBe("New York");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/deliveryAddressInput.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `@/lib/deliveryAddressInput`.

- [ ] **Step 3: Write the implementation**

Create `lib/deliveryAddressInput.ts`:

```ts
// Validate the delivery-address block a customer submits.
//
// Separate from lib/deliveryAddress.ts, which READS what is already stored.
// This is the write side, and it is stricter: the stored form has to tolerate
// whatever is in the database, while nothing partial may ever be written.
//
// Pure, so the form can run exactly the same validation before submitting.
import { normalizeCountry, SUPPORTED_COUNTRIES } from "./countries";

export type DeliveryInput = {
  readonly name: string;
  readonly address1: string;
  readonly address2: string | null;
  readonly zip: string;
  readonly city: string;
  readonly province: string | null;
  readonly country: string;
};

export type DeliveryParse =
  | { ok: true; value: DeliveryInput | null }
  | { ok: false; reason: "partial" | "unsupported-country" };

const SUPPORTED = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));

const trim = (value: string | undefined): string => (value ?? "").trim();

/** The fields that make an address deliverable and priceable. `address2` and
 *  `province` are excluded: plenty of real addresses have neither, and
 *  `province` is only ever sent to Shopify for Spain. */
const REQUIRED = [
  "deliveryName",
  "deliveryAddress1",
  "deliveryZip",
  "deliveryCity",
  "deliveryCountry",
] as const;

/**
 * Parse the delivery block out of a submitted form.
 *
 * Three outcomes, and the caller must distinguish them:
 *  - `{ ok: true, value: null }` — the customer did not ask for a separate
 *    delivery address. Clear any stored one.
 *  - `{ ok: true, value }` — a complete, priceable address.
 *  - `{ ok: false }` — reject the whole submission. Never write half.
 *
 * All-or-nothing is the point. A partial write would leave
 * `hasSeparateDelivery` false, so the replacement would quietly ship to the
 * collection address while the customer believed otherwise — and the fee they
 * were quoted would not match the fee they were charged.
 */
export function parseDeliveryInput(
  fields: Record<string, string | undefined>
): DeliveryParse {
  const present = REQUIRED.map((key) => trim(fields[key]));
  const filledCount = present.filter((v) => v.length > 0).length;

  // Nothing asked for. Not an error — this is the common case.
  if (filledCount === 0) return { ok: true, value: null };
  if (filledCount < REQUIRED.length) return { ok: false, reason: "partial" };

  // The country sets the price, so it is the one field that cannot be free
  // text. `normalizeCountry` accepts either a display name or an ISO-2 code
  // and returns the code.
  const country = normalizeCountry(trim(fields.deliveryCountry));
  if (!country || !SUPPORTED.has(country)) {
    return { ok: false, reason: "unsupported-country" };
  }

  const address2 = trim(fields.deliveryAddress2);
  const province = trim(fields.deliveryProvince);

  return {
    ok: true,
    value: {
      name: trim(fields.deliveryName),
      address1: trim(fields.deliveryAddress1),
      address2: address2.length > 0 ? address2 : null,
      zip: trim(fields.deliveryZip),
      city: trim(fields.deliveryCity),
      province: province.length > 0 ? province : null,
      country,
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/deliveryAddressInput.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (9 tests)

- [ ] **Step 5: Wire it into `updateData`**

In `actions/updateOrder.ts`, extend `FormDataFields` (after `phone`):

```ts
  // The delivery block. Absent for almost every submission — see updateData.
  deliveryName?: string;
  deliveryAddress1?: string;
  deliveryAddress2?: string;
  deliveryZip?: string;
  deliveryCity?: string;
  deliveryProvince?: string;
  // Unlike `country` above, this one IS read from the form. It sets the
  // outbound leg's price, not the carrier lane, and parseDeliveryInput
  // restricts it to SUPPORTED_COUNTRIES.
  deliveryCountry?: string;
```

and extend `parseFormData` (after `phone`):

```ts
    deliveryName: formData.get("deliveryName")?.toString(),
    deliveryAddress1: formData.get("deliveryAddress1")?.toString(),
    deliveryAddress2: formData.get("deliveryAddress2")?.toString(),
    deliveryZip: formData.get("deliveryZip")?.toString(),
    deliveryCity: formData.get("deliveryCity")?.toString(),
    deliveryProvince: formData.get("deliveryProvince")?.toString(),
    deliveryCountry: formData.get("deliveryCountry")?.toString(),
```

In `updateData`, after the existing `if (!data.orderId || !data.name || !data.address) return prevState;` guard and before the `db.update`:

```ts
  // The delivery block is validated before anything is written, and a bad one
  // rejects the WHOLE submission rather than being dropped: silently ignoring
  // it would advance the customer to checkout believing their replacement is
  // going somewhere it is not.
  const delivery = parseDeliveryInput(data as Record<string, string | undefined>);
  if (!delivery.ok) {
    console.warn(
      `updateData: rejected the delivery address on order ${data.orderId} (${delivery.reason})`
    );
    return prevState;
  }
```

and extend the `.set({ ... })` object with:

```ts
      // Null when the customer did not ask for a separate address, which also
      // CLEARS a previously stored one — unticking the box has to undo it.
      deliveryName: delivery.value?.name ?? null,
      deliveryAddress1: delivery.value?.address1 ?? null,
      deliveryAddress2: delivery.value?.address2 ?? null,
      deliveryZip: delivery.value?.zip ?? null,
      deliveryCity: delivery.value?.city ?? null,
      deliveryProvince: delivery.value?.province ?? null,
      deliveryCountry: delivery.value?.country ?? null,
```

Add the import:
```ts
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add actions/updateOrder.ts lib/deliveryAddressInput.ts tests/deliveryAddressInput.test.ts
git commit -m "feat: accept a delivery address on the portal address form

updateData now reads a delivery_* block, validated all-or-nothing. A partial
or unsupported-country block rejects the whole submission rather than being
dropped: silently ignoring it would advance the customer to checkout believing
their replacement is going somewhere it is not, and the fee they were quoted
would not match the fee they were charged.

An absent block writes nulls, which also clears a previously stored address --
unticking the box has to undo it.

shipping_country remains unreadable from this form. delivery_country is
readable because it sets the outbound leg's price, not the carrier lane, and
it is restricted to SUPPORTED_COUNTRIES rather than accepted as free text.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 7: Carry the whole fee table to the client

The portal currently receives one country's bands, which cannot price a second country the customer picks in the browser.

**Files:**
- Modify: `app/[id]/feesContext.tsx` (whole file)
- Modify: `app/[id]/page.tsx:79-81, 112-121`
- Modify: `app/[id]/clientOrder.tsx` (add the delivery-draft state)
- Test: `tests/feesContext.render.test.tsx`

**Interfaces:**
- Consumes: `FeeTable`, `FeeLegs` (Task 1); `feeLegsForOrder` (Task 3)
- Produces:
  - `export const FeesProvider: ({ table, order, children }: { table: FeeTable; order: OrderAddressFields; children: ReactNode }) => JSX.Element`
  - `export const useFeeLegs: () => FeeLegs` — the legs for the CURRENT draft, delivery draft included
  - `export const useDeliveryDraft: () => { draft: DeliveryInput | null; setDraft: (d: DeliveryInput | null) => void }`

- [ ] **Step 1: Write the failing test**

Create `tests/feesContext.render.test.tsx`. Model the render setup on the existing `tests/returnMethodThreading.render.test.tsx` — read it first for this repo's React-testing conventions:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { FeesProvider, useFeeLegs, useDeliveryDraft } from "@/app/[id]/feesContext";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, resolveFee, type FeeTable } from "@/lib/fees";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];

const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  US: flat(2200, 3496),
};

const ORDER = {
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "España",
  deliveryName: null,
  deliveryAddress1: null,
  deliveryAddress2: null,
  deliveryZip: null,
  deliveryCity: null,
  deliveryProvince: null,
  deliveryCountry: null,
} as any;

let setDraftRef: (d: any) => void = () => {};

function Probe() {
  const legs = useFeeLegs();
  const { setDraft } = useDeliveryDraft();
  setDraftRef = setDraft;
  const { feeCents } = resolveFee(legs, { hasItems: true, netAmount: 0, grams: 500 });
  return <span data-testid="fee">{feeCents}</span>;
}

describe("FeesProvider", () => {
  it("prices both legs in the collection zone with no draft", () => {
    render(
      <FeesProvider table={TABLE} order={ORDER}>
        <Probe />
      </FeesProvider>
    );
    expect(screen.getByTestId("fee").textContent).toBe("850");
  });

  it("reprices the outbound leg when a delivery draft is set", () => {
    render(
      <FeesProvider table={TABLE} order={ORDER}>
        <Probe />
      </FeesProvider>
    );
    act(() => {
      setDraftRef({
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: null,
        zip: "10271",
        city: "New York",
        province: "NY",
        country: "US",
      });
    });
    // 500 collected in Spain + 1296 delivered to the US.
    expect(screen.getByTestId("fee").textContent).toBe("1796");
  });

  it("returns to the collection zone when the draft is cleared", () => {
    render(
      <FeesProvider table={TABLE} order={ORDER}>
        <Probe />
      </FeesProvider>
    );
    act(() => {
      setDraftRef({
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: null,
        zip: "10271",
        city: "New York",
        province: "NY",
        country: "US",
      });
    });
    act(() => setDraftRef(null));
    expect(screen.getByTestId("fee").textContent).toBe("850");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/feesContext.render.test.tsx --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `FeesProvider` does not accept `table`/`order`, and `useFeeLegs` is not exported.

- [ ] **Step 3: Rewrite `app/[id]/feesContext.tsx`**

```tsx
"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { feesForCountry, type FeeLegs, type FeeTable } from "@/lib/fees";
import { resolveZone } from "@/lib/zones";
import { feeLegsForOrder } from "@/lib/feeLegs";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import type { DeliveryInput } from "@/lib/deliveryAddressInput";

/**
 * Carries the fee table and the customer's in-progress delivery address to the
 * components that display the price.
 *
 * Was one country's bands, resolved on the server at page load. That cannot
 * price a SECOND country the customer picks in the browser, which is the whole
 * of this feature — so the table travels instead. It is 235 rows.
 *
 * Shipping the whole table to the client is safe for the same reason the old
 * comment gave: this is for DISPLAY ONLY. The amount actually charged is
 * recomputed server-side in actions/payments.ts from the stored order, never
 * from anything the browser says. A customer who edits the table in devtools
 * changes the number on their own screen and nothing else.
 *
 * The delivery DRAFT lives here rather than in the form because the summary,
 * the method screen and the final screen all price from it and none of them
 * owns the form.
 */

type FeesValue = {
  readonly table: FeeTable;
  readonly order: OrderAddressFields;
  readonly draft: DeliveryInput | null;
  readonly setDraft: (draft: DeliveryInput | null) => void;
};

const EMPTY_TABLE: FeeTable = {};

const FeesContext = createContext<FeesValue>({
  table: EMPTY_TABLE,
  order: null as unknown as OrderAddressFields,
  draft: null,
  setDraft: () => {},
});

export const FeesProvider = ({
  table,
  order,
  children,
}: {
  table: FeeTable;
  order: OrderAddressFields;
  children: ReactNode;
}) => {
  const [draft, setDraft] = useState<DeliveryInput | null>(null);
  const value = useMemo(
    () => ({ table, order, draft, setDraft }),
    [table, order, draft]
  );
  return <FeesContext.Provider value={value}>{children}</FeesContext.Provider>;
};

/**
 * The two band lists the current basket is priced from.
 *
 * The collection leg always comes from the stored order. The delivery leg
 * comes from the draft if the customer is filling one in, and otherwise from
 * whatever is stored — which is the collection address unless a previous
 * submission saved something else.
 *
 * The draft takes precedence over the stored value so the price on screen
 * tracks what the customer is typing, before they submit.
 */
export const useFeeLegs = (): FeeLegs => {
  const { table, order, draft } = useContext(FeesContext);
  return useMemo(() => {
    const stored = feeLegsForOrder(table, order);
    if (!draft) return stored;
    return {
      collection: stored.collection,
      delivery: feesForCountry(table, resolveZone(draft.country, draft.zip)),
    };
  }, [table, order, draft]);
};

export const useDeliveryDraft = (): {
  draft: DeliveryInput | null;
  setDraft: (draft: DeliveryInput | null) => void;
} => {
  const { draft, setDraft } = useContext(FeesContext);
  return { draft, setDraft };
};
```

- [ ] **Step 4: Update `app/[id]/page.tsx`**

Replace lines 78-81:

```ts
  const feeTable = await getFeeTable();
```

(delete the `const fees = feesForCountry(...)` block entirely) and replace the provider at line 112:

```tsx
      <FeesProvider table={feeTable} order={orderData as any}>
```

Remove the now-unused `feesForCountry` and `resolveZone` imports if nothing else in the file uses them.

- [ ] **Step 5: Update the six `useFees()` consumers**

`useFees` is deleted, so the compiler finds all six. In each, replace `const fees = useFees();` with `const legs = useFeeLegs();`, change the import from `useFees` to `useFeeLegs`, replace `resolveFee(sameZone(fees), ...)` with `resolveFee(legs, ...)`, and drop the now-unused `sameZone` import.

| File | `useFees()` at | What it does with the value |
|---|---|---|
| `app/[id]/components/secondWindowForm.tsx` | 42 | `resolveFee` at 43 |
| `app/[id]/components/summary/summary.tsx` | 93 | `resolveFee` at 94 |
| `app/[id]/windows/thirdWindow.tsx` | 175 | `resolveFee` at 190, inside a `useMemo` |
| `app/[id]/windows/lastWindow.tsx` | 50 | `resolveFee` at 62, inside a `useMemo` |
| `app/[id]/windows/orderWindowContent.tsx` | 42 | passes it to `calculatePrices` at 44 |
| `app/[id]/windows/secondWindow.tsx` | 47 | `resolveFee` at 53 |

Rename `fees` to `legs` in every `useMemo` dependency array that lists it — `lastWindow.tsx:80` and `orderWindowContent.tsx:45` both do. A stale dependency here means the price on screen stops tracking the delivery country the customer just picked, which is the one thing this feature exists to do.

`orderWindowContent.tsx` becomes `calculatePrices(items, allProducts, legs)` — the `sameZone` wrapper added in Task 1 comes back off, since `calculatePrices` already takes a `FeeLegs` after that task.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/feesContext.render.test.tsx --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (3 tests)

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add app/ tests/feesContext.render.test.tsx
git commit -m "refactor: carry the fee table to the client, not one country's bands

FeesProvider received the order country's bands, resolved on the server at page
load. That cannot price a second country the customer picks in the browser,
which is the whole of this feature, so the table travels instead -- 235 rows.

Still display-only, for the same reason as before: the charge is recomputed
server-side in actions/payments.ts from the stored order, never from anything
the browser says.

The in-progress delivery address lives in the same provider because the
summary, the method screen and the final screen all price from it and none of
them owns the form.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 8: The delivery-address form

**Files:**
- Create: `app/[id]/components/deliveryAddressFields.tsx`
- Modify: `app/[id]/components/secondWindowForm.tsx`
- Modify: `lib/i18n/en.ts`, `lib/i18n/es.ts`
- Test: `tests/deliveryAddressFields.render.test.tsx`

**Interfaces:**
- Consumes: `useDeliveryDraft` (Task 7), `parseDeliveryInput` (Task 6), `SUPPORTED_COUNTRIES`
- Produces: `export const DeliveryAddressFields: ({ order }: { order: OrderAddressFields }) => JSX.Element`

- [ ] **Step 1: Add the i18n keys**

In `lib/i18n/en.ts`, inside the `second` block, after `phone`:

```ts
    // The alternate delivery address. Shown only when the basket contains an
    // exchange — a pure return has no replacement to deliver.
    deliverElsewhere: "Deliver my replacement to a different address",
    deliverElsewhereHint:
      "Your parcel is still collected from the address above. Only the replacement goes here, and the delivery cost is updated for that country.",
    deliveryCountry: "Delivery country",
    deliveryIncomplete: "Please fill in every delivery field except the optional ones.",
```

In `lib/i18n/es.ts`, inside its `second` block, after `phone` — use exactly these values:

```ts
    // La dirección de entrega alternativa. Solo se muestra cuando hay un
    // cambio: una devolución pura no tiene nada que entregar.
    deliverElsewhere: "Enviar mi producto de cambio a otra dirección",
    deliverElsewhereHint:
      "Tu paquete se seguirá recogiendo en la dirección de arriba. Solo el producto de cambio se envía aquí, y el coste de envío se actualiza para ese país.",
    deliveryCountry: "País de entrega",
    deliveryIncomplete:
      "Por favor, rellena todos los campos de entrega salvo los opcionales.",
```

Both dictionaries are typed against the same `Dictionary` shape, so omitting a key from either is a compile error rather than a silent English string in a Spanish session.

- [ ] **Step 2: Write the failing test**

Create `tests/deliveryAddressFields.render.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FeesProvider } from "@/app/[id]/feesContext";
import { DeliveryAddressFields } from "@/app/[id]/components/deliveryAddressFields";
import { LocaleProvider } from "@/lib/i18n/context";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  US: flat(2200, 3496),
};
const ORDER = {
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "España",
  deliveryName: null,
  deliveryAddress1: null,
  deliveryAddress2: null,
  deliveryZip: null,
  deliveryCity: null,
  deliveryProvince: null,
  deliveryCountry: null,
} as any;

function mount() {
  return render(
    <LocaleProvider locale="en">
      <FeesProvider table={TABLE} order={ORDER}>
        <DeliveryAddressFields order={ORDER} />
      </FeesProvider>
    </LocaleProvider>
  );
}

describe("DeliveryAddressFields", () => {
  it("renders collapsed, with no delivery inputs in the form", () => {
    mount();
    expect(screen.queryByLabelText(/delivery country/i)).toBeNull();
    // Nothing named delivery* may be submitted while it is collapsed.
    expect(document.querySelector('[name^="delivery"]')).toBeNull();
  });

  it("reveals the fields when the box is ticked", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(document.querySelector('[name="deliveryAddress1"]')).not.toBeNull();
    expect(document.querySelector('[name="deliveryCountry"]')).not.toBeNull();
  });

  // Unticking has to remove the inputs, so updateData writes nulls and clears
  // any stored address.
  it("removes the fields again when the box is unticked", () => {
    mount();
    const box = screen.getByRole("checkbox");
    fireEvent.click(box);
    fireEvent.click(box);
    expect(document.querySelector('[name^="delivery"]')).toBeNull();
  });

  it("offers only supported countries", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox"));
    const select = document.querySelector('[name="deliveryCountry"]') as HTMLSelectElement;
    const codes = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(codes).toContain("US");
    expect(codes).toContain("ES");
    expect(codes).not.toContain("Freedonia");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/deliveryAddressFields.render.test.tsx --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `@/app/[id]/components/deliveryAddressFields`.

- [ ] **Step 4: Give `FormInput` an optional `onChange`**

`FormInput` (`components/formInput.tsx`) is uncontrolled — it seeds its own `useState` from `valueini` and never tells the parent about keystrokes. The delivery fields need to, so the price on screen tracks what is typed.

Add the prop to `FormInputProps`:
```ts
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
```

Accept it in the destructured parameter list, and call it at the end of the existing `handleChange` — after the internal `setValue` and `validateInput`, so `FormInput` keeps owning its own display state and every existing caller is unaffected:

```ts
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    validateInput(newValue);
    // Optional: only the delivery fields need to drive a price elsewhere on
    // the page. Called last so the input's own state is already settled.
    onChange?.(e);
  };
```

- [ ] **Step 5: Write the component**

Create `app/[id]/components/deliveryAddressFields.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { FormInput } from "@/components/formInput";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { useLocale, useT } from "@/lib/i18n/context";
import { useDeliveryDraft } from "../feesContext";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";
import {
  deliveryAddressOf,
  hasSeparateDelivery,
  type OrderAddressFields,
} from "@/lib/deliveryAddress";

/**
 * "Deliver my replacement somewhere else."
 *
 * Rendered only when the basket contains an exchange; a pure return has no
 * replacement to deliver, and offering the choice there would let a customer
 * raise their own price for nothing.
 *
 * Collapsed, it renders NO inputs at all — not hidden ones. `updateData`
 * writes null for every delivery column when the block is absent, so an
 * unticked box is what clears a previously stored address. Hidden inputs would
 * keep submitting it.
 *
 * The country is a <select> over SUPPORTED_COUNTRIES rather than free text,
 * because it sets the outbound leg's price. `parseDeliveryInput` enforces the
 * same restriction server-side; this is convenience, not the control.
 */
export const DeliveryAddressFields = ({ order }: { order: OrderAddressFields }) => {
  const t = useT();
  const { setDraft } = useDeliveryDraft();
  // Reopen already-ticked if the customer saved one on a previous pass.
  const [open, setOpen] = useState(() => hasSeparateDelivery(order));
  const stored = hasSeparateDelivery(order) ? deliveryAddressOf(order) : null;

  const [fields, setFields] = useState<Record<string, string>>(() => ({
    deliveryName: stored?.name ?? order.shippingName ?? "",
    deliveryAddress1: stored?.address1 ?? "",
    deliveryAddress2: stored?.address2 ?? "",
    deliveryZip: stored?.zip ?? "",
    deliveryCity: stored?.city ?? "",
    deliveryProvince: stored?.province ?? "",
    deliveryCountry: stored?.country ?? "",
  }));

  // Keep the price on screen tracking what is typed. Only a COMPLETE, valid
  // block moves the price — a half-filled one would otherwise flicker the
  // total through whatever country happened to be selected first.
  useEffect(() => {
    if (!open) {
      setDraft(null);
      return;
    }
    const parsed = parseDeliveryInput(fields);
    setDraft(parsed.ok ? parsed.value : null);
  }, [open, fields, setDraft]);

  const set = (name: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [name]: e.target.value }));

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => setOpen(e.target.checked)}
          className="mt-1"
        />
        <span className="flex flex-col">
          <span className="text-xs sm:text-sm font-semibold">
            {t.second.deliverElsewhere}
          </span>
          <span className="text-xxs sm:text-xs text-gray-600">
            {t.second.deliverElsewhereHint}
          </span>
        </span>
      </label>

      {open && (
        <div className="flex flex-col gap-4 border-l-2 border-shameless-orange pl-3">
          <FormInput
            name="deliveryName"
            title={t.second.name}
            valueini={fields.deliveryName}
            icon={false}
            onChange={set("deliveryName")}
          />
          <FormInput
            name="deliveryAddress1"
            title={t.second.address}
            valueini={fields.deliveryAddress1}
            icon={false}
            onChange={set("deliveryAddress1")}
          />
          <FormInput
            name="deliveryAddress2"
            title={t.second.address2}
            valueini={fields.deliveryAddress2}
            icon={false}
            onChange={set("deliveryAddress2")}
          />
          <FormInput
            name="deliveryZip"
            title={t.second.zip}
            valueini={fields.deliveryZip}
            icon={false}
            onChange={set("deliveryZip")}
          />
          <FormInput
            name="deliveryCity"
            title={t.second.city}
            valueini={fields.deliveryCity}
            icon={false}
            onChange={set("deliveryCity")}
          />
          <FormInput
            name="deliveryProvince"
            title={t.second.province}
            valueini={fields.deliveryProvince}
            icon={false}
            onChange={set("deliveryProvince")}
          />
          <div className="flex flex-col gap-2">
            <label
              htmlFor="deliveryCountry"
              className="text-xs text-slate-600"
            >
              {t.second.deliveryCountry}
            </label>
            <select
              id="deliveryCountry"
              name="deliveryCountry"
              value={fields.deliveryCountry}
              onChange={(e) =>
                setFields((f) => ({ ...f, deliveryCountry: e.target.value }))
              }
              className="w-full p-2 border border-slate-200 rounded-md"
            >
              <option value="" />
              {countryOptions.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
};
```

`Country` (`lib/countries.ts:11-17`) has `code`, `nameEs` and `nameEn` — there is no `name`. Build the option list once, in the customer's own language and sorted by it, just above the `return`:

```ts
  // Sorted by the name the customer actually reads, not by ISO code: an
  // alphabetical list of codes puts Austria under "AT" and Australia under
  // "AU", which is navigable only if you already know the code.
  const countryOptions = useMemo(
    () =>
      SUPPORTED_COUNTRIES.map((c) => ({
        code: c.code,
        label: locale === "es" ? c.nameEs : c.nameEn,
      })).sort((a, b) => a.label.localeCompare(b.label, locale)),
    [locale]
  );
```

which needs `const locale = useLocale();` alongside the existing `const t = useT();`, and `useMemo` added to the React import.

- [ ] **Step 6: Mount it in the address form**

In `app/[id]/components/secondWindowForm.tsx`, the component needs to know whether the basket has an exchange. Immediately after `const basket = valueBasket(items, allProducts);`:

```ts
  // Only an exchange has a replacement to deliver. A pure return must not be
  // offered a delivery address: there is nothing to send, and the outbound leg
  // it would price is zero.
  //
  // ACTIONS.CHANGE, never the literal "CAMBIO" and never the dropdown's label:
  // productsorder.action stores the stable code, and comparing against the
  // localized text is what once made an English exchange save as a return.
  // `!confirmed` matches the filter orderWindowContent already uses — a line
  // already submitted on an earlier pass is not part of this basket.
  const hasExchange = items.some(
    (item) => item.action === ACTIONS.CHANGE && !item.confirmed
  );
```

and render it between the phone input and the `<span className="border ..." />` separator:

```tsx
      {hasExchange && (
        <>
          <span className="border w-full border-gray-300 mt-2" />
          <DeliveryAddressFields order={order as unknown as OrderAddressFields} />
        </>
      )}
```

Add the imports:
```ts
import { DeliveryAddressFields } from "./deliveryAddressFields";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import { ACTIONS } from "@/placeholder";
```

(`productsorder` declares `action: text` and `confirmed: boolean` — `db/schema.ts` — and `ACTIONS.CHANGE === "CAMBIO"` in `placeholder.ts`.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/deliveryAddressFields.render.test.tsx --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (4 tests)

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS

Run: `npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add app/ lib/i18n/ components/formInput.tsx tests/deliveryAddressFields.render.test.tsx
git commit -m "feat: offer an alternate delivery address on exchanges

Shown only when the basket contains an exchange: a pure return has no
replacement to deliver, and offering the choice there would let a customer
raise their own price for nothing.

Collapsed it renders no inputs at all rather than hidden ones, because
updateData writes null for every delivery column when the block is absent --
an unticked box is what clears a previously stored address, and hidden inputs
would keep submitting it.

The country is a select over SUPPORTED_COUNTRIES because it sets the outbound
leg's price. parseDeliveryInput enforces the same restriction server-side;
this is convenience, not the control.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

### Task 9: End-to-end verification

No new behaviour. This task proves the eight before it agree with each other.

**Files:**
- Create: `tests/splitDeliveryEndToEnd.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Write the end-to-end test**

Create `tests/splitDeliveryEndToEnd.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { resolveFee, checkoutLines, centsToEuros, DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";
import { deliveryAddressOf, hasSeparateDelivery } from "@/lib/deliveryAddress";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  US: flat(2200, 3496),
};

/** The whole journey: what the form submits -> what is stored -> what is charged. */
describe("Spain collection, US delivery", () => {
  const submitted = {
    deliveryName: "Ana Ruiz",
    deliveryAddress1: "120 Broadway",
    deliveryAddress2: "Apt 4",
    deliveryZip: "10271",
    deliveryCity: "New York",
    deliveryProvince: "NY",
    deliveryCountry: "US",
  };

  it("carries the form through storage to the charge", () => {
    const parsed = parseDeliveryInput(submitted);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok || !parsed.value) throw new Error("unreachable");

    // What updateData would write.
    const stored = {
      shippingName: "Ana Ruiz",
      shippingAddress1: "Calle Mayor 1",
      shippingAddress2: null,
      shippingZip: "28013",
      shippingCity: "Madrid",
      shippingProvince: "Madrid",
      shippingCountry: "España",
      deliveryName: parsed.value.name,
      deliveryAddress1: parsed.value.address1,
      deliveryAddress2: parsed.value.address2,
      deliveryZip: parsed.value.zip,
      deliveryCity: parsed.value.city,
      deliveryProvince: parsed.value.province,
      deliveryCountry: parsed.value.country,
    } as any;

    expect(hasSeparateDelivery(stored)).toBe(true);
    expect(deliveryAddressOf(stored).country).toBe("US");

    // What createStripeUrl would charge for an even swap.
    const legs = feeLegsForOrder(TABLE, stored);
    const basket = { hasItems: true, netAmount: 0, grams: 500 };
    const { feeCents, returnLegCents, outboundLegCents } = resolveFee(legs, basket);
    expect(returnLegCents).toBe(500);
    expect(outboundLegCents).toBe(1296);
    expect(feeCents).toBe(1796);

    // The Stripe line items must sum to exactly what is charged, or the
    // caller falls back to one opaque line.
    const amountCents = Math.round(-(basket.netAmount - centsToEuros(feeCents)) * 100);
    const lines = checkoutLines(basket, { returnLegCents, outboundLegCents }, amountCents);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(amountCents);
    expect(lines.map((l) => l.kind)).toEqual(["returnShipping", "deliveryShipping"]);
  });

  it("costs the Spanish price when the customer does not ask to redirect it", () => {
    const stored = {
      shippingName: "Ana Ruiz",
      shippingAddress1: "Calle Mayor 1",
      shippingAddress2: null,
      shippingZip: "28013",
      shippingCity: "Madrid",
      shippingProvince: "Madrid",
      shippingCountry: "España",
      deliveryName: null,
      deliveryAddress1: null,
      deliveryAddress2: null,
      deliveryZip: null,
      deliveryCity: null,
      deliveryProvince: null,
      deliveryCountry: null,
    } as any;
    const legs = feeLegsForOrder(TABLE, stored);
    expect(resolveFee(legs, { hasItems: true, netAmount: 0, grams: 500 }).feeCents).toBe(850);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/splitDeliveryEndToEnd.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (2 tests)

- [ ] **Step 3: Run everything**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS — 94+ files. Record the file and test counts; compare against the pre-change baseline of 94 files / 949 tests plus the tests this plan adds.

Run: `npx tsc --noEmit && npm run build`
Expected: both clean.

- [ ] **Step 4: Confirm the untouched paths really are untouched**

Settlement and carrier booking must be exactly as they were. Confirm none of them reads a delivery column or the delivery leg:

```bash
grep -nE "deliveryAddressOf|feeLegsForOrder|delivery(Name|Address1|Zip|City|Province|Country)|outboundLegCents" \
  lib/settleReturn.ts actions/shipping.ts actions/amphoraReturn.ts \
  actions/selfBookedReturn.ts actions/updateOrder.ts
```

Expected: matches in `actions/updateOrder.ts` only (it writes the columns in Task 6 — `deliveryAddressOf` and `outboundLegCents` must NOT appear even there). Any match in the other four means a leg has leaked into settlement or carrier booking; stop and re-read the spec's blast-radius table.

Then confirm the return leg is still what it was:

```bash
git diff main --stat -- lib/settleReturn.ts actions/shipping.ts actions/amphoraReturn.ts
```
Expected: no output. These three files are untouched by the whole branch.

- [ ] **Step 5: Commit**

```bash
git add tests/splitDeliveryEndToEnd.test.ts
git commit -m "test: prove the split delivery address end to end

Form submission through storage to the Stripe charge, and the negative case:
an order with no delivery address still costs the Spanish price.

Also asserts the checkout lines sum exactly to the charged amount under split
legs -- itemisation must describe the charge, never change it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TaET3YvN7qLLNmxtjRHaof"
```

---

## Manual QA before merge

Preview and production share one `DATABASE_URL`, so **every one of these writes to a live customer order**. Use an order that belongs to the shop owner, and expect the 60-day window to block most of them.

1. Open a portal session for an order with an exchangeable line. Confirm the address step looks unchanged and the box is absent for a pure return.
2. Select an exchange. Confirm the box appears, and that the summary still reads the Spanish fee while it is unticked.
3. Tick it, fill in a US address. Confirm the summary's "Delivery of new items" line moves from €3.50 to €12.96 and the total from €8.50 to €17.96.
4. Untick it. Confirm the total returns to €8.50 — this is the clearing path, which is the easiest one to get wrong.
5. Submit with the box ticked and one field blank. Confirm the submission is refused rather than silently saved without the address.
6. Complete a real checkout and confirm the Stripe session shows two shipping lines — "Return shipping €5.00" and "Delivery of new items €12.96" — not one merged fee.
7. Confirm in Shopify that the resulting exchange order's shipping address is the US one and its billing address is the Spanish one.

## Out of scope, carried from the spec

Do not fix these in this branch:

1. **The US outbound rate is too low.** €12.96 comes from `$15.00` in `data/outbound-rates.csv`, which is the store's published Shopify delivery rate. The FX is correct. Fixing it is a Shopify delivery-profile edit plus `scripts/tariff/outbound.mjs` plus a reseed.
2. **`CA,Canada,29.9,CAD,5163`** is a worst-case placeholder, not a conversion.
3. **`createOrder` hardcodes `shippingLines: "4.00 EUR / Estándar"` and `currency: "EUR"`** on every exchange order (`db/queries.ts:672`). Neither affects what the customer is charged, but both will look wrong on a US-bound order.
