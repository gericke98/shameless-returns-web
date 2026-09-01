# Exchange Keeps The Price You Paid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer exchanging a garment for a different size of the same garment is charged exactly €0, whatever the catalogue says today.

**Architecture:** Replace the catalogue-wide `applyGlobalDiscount` mutation with a pure per-line pricing function. A replacement's price becomes a property of the *(line, replacement)* pairing rather than of the catalogue, so the catalogue is passed down raw and no object in the system carries a price that is not a real price.

**Tech Stack:** Next.js App Router, TypeScript, Drizzle + Neon, Shopify Admin GraphQL, Stripe Checkout, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-exchange-keeps-sale-price-design.md`

## Global Constraints

- `lib/replacementPricing.ts` is a **pure module**: no `db`, no `env`, no network, no `"use server"`. It must be importable from a client component and unit-testable without mocks. Same rule the header of `lib/basket.ts` states for itself.
- `productsorder.variant_id` is a **bare numeric id**. `new_variant_id` and every Shopify catalogue id are **full GIDs**. Every lookup of the *original* variant against the catalogue goes through `variantGid()` from `@/lib/shopifyIds`.
- Money rounds to cents once, at the point of return: `Math.round(x * 100) / 100`. Do not chain arithmetic on rounded euros (`lib/fees.ts:191`).
- Test runner: `npm test` (`vitest run`). Single file: `npx vitest run tests/<file>.test.ts`.
- No database migration. No backfill. `productsorder` is unchanged by this plan.
- Do not change what a plain return refunds, the return fee, or either shipping leg.

---

### Task 1: The pure pricing module

**Files:**
- Create: `lib/replacementPricing.ts`
- Test: `tests/replacementPricing.test.ts`

**Interfaces:**
- Consumes: `variantGid` from `@/lib/shopifyIds`; `Product` from `@/types`.
- Produces:
  - `type PricingBasis = "paid" | "ratio" | "median" | "none"`
  - `type PricedResult = { price: number; basis: PricingBasis }`
  - `type PricedLine = { productId: string; variant_id: string; new_variant_id: string | null; price: string }`
  - `type CatalogueIndex = { priceOf(id): number | null; productOf(id): string | null }`
  - `indexCatalogue(catalogue: Product[]): CatalogueIndex`
  - `lineRatio(line: PricedLine, index: CatalogueIndex): number | null`
  - `orderRatio(lines: PricedLine[], index: CatalogueIndex): number | null`
  - `replacementPriceForVariant(line, newVariantId: string | null, index, fallbackRatio: number | null): PricedResult`
  - `replacementPrice(line, index, fallbackRatio): PricedResult`

- [ ] **Step 1: Write the failing tests**

Create `tests/replacementPricing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  indexCatalogue,
  lineRatio,
  orderRatio,
  replacementPrice,
  replacementPriceForVariant,
  type PricedLine,
} from "@/lib/replacementPricing";
import type { Product } from "@/types";

const vgid = (n: string) => `gid://shopify/ProductVariant/${n}`;

/** Minimal catalogue shaped exactly like getProducts() returns. */
function product(
  productId: string,
  variants: { id: string; price: string }[]
): Product {
  return {
    id: `gid://shopify/Product/${productId}`,
    title: `P${productId}`,
    handle: `p${productId}`,
    description: "",
    images: { edges: [] },
    image: { src: "" },
    variants: {
      edges: variants.map((v) => ({
        node: {
          id: vgid(v.id),
          price: v.price,
          title: v.id,
          inventoryQuantity: 5,
          grams: 400,
        },
      })),
    },
  };
}

// Order #311749, 2026-08-27. Sale prices paid; catalogue is back to list.
const CREWNECK = product("15296978026822", [
  { id: "55598268973382", price: "55.00" }, // Large, the one he bought
  { id: "55598268940614", price: "55.00" }, // Medium, the one he wants
]);
const PANTS = product("14958568177990", [
  { id: "54623384437062", price: "69.00" }, // Large (42), bought
  { id: "54623384404294", price: "69.00" }, // Medium (40), wanted
]);
const CATALOGUE = [CREWNECK, PANTS];

const franCrewneck: PricedLine = {
  productId: "15296978026822",
  variant_id: "55598268973382", // BARE, as productsorder stores it
  new_variant_id: vgid("55598268940614"),
  price: "42.75",
};
const franPants: PricedLine = {
  productId: "14958568177990",
  variant_id: "54623384437062",
  new_variant_id: vgid("54623384404294"),
  price: "47.03",
};

describe("replacementPrice — order #311749 regression", () => {
  it("charges nothing for either size swap", () => {
    const index = indexCatalogue(CATALOGUE);
    const fallback = orderRatio([franCrewneck, franPants], index);

    const crewneck = replacementPrice(franCrewneck, index, fallback);
    const pants = replacementPrice(franPants, index, fallback);

    expect(crewneck).toEqual({ price: 42.75, basis: "paid" });
    expect(pants).toEqual({ price: 47.03, basis: "paid" });

    const paid = 42.75 + 47.03;
    const owed = crewneck.price + pants.price;
    expect(Math.round((paid - owed) * 100) / 100).toBe(0);
  });

  it("does not borrow line 1's ratio for line 2", () => {
    const index = indexCatalogue(CATALOGUE);
    // The old bug: 69.00 * (42.75/55.00) = 53.63, a EUR 6.60 overcharge.
    const pants = replacementPrice(franPants, index, orderRatio([], index));
    expect(pants.price).not.toBeCloseTo(53.63, 2);
    expect(pants.price).toBe(47.03);
  });
});

describe("same-product swaps never depend on the catalogue", () => {
  it("returns the paid price for any catalogue, including an empty one", () => {
    for (const cat of [CATALOGUE, [], [PANTS]]) {
      const index = indexCatalogue(cat);
      expect(replacementPrice(franCrewneck, index, null)).toEqual({
        price: 42.75,
        basis: "paid",
      });
    }
  });

  it("is unmoved when the catalogue price triples", () => {
    const inflated = [
      product("15296978026822", [
        { id: "55598268973382", price: "165.00" },
        { id: "55598268940614", price: "165.00" },
      ]),
    ];
    const index = indexCatalogue(inflated);
    expect(replacementPrice(franCrewneck, index, null).price).toBe(42.75);
  });
});

describe("cross-product exchanges carry the line's own discount depth", () => {
  const crossToPants: PricedLine = {
    ...franCrewneck,
    new_variant_id: vgid("54623384404294"), // pants, a DIFFERENT product
  };

  it("applies the line's own ratio, not a sibling's", () => {
    const index = indexCatalogue(CATALOGUE);
    // ratio = 42.75 / 55.00 = 0.777272...; 69.00 * that = 53.63
    expect(replacementPrice(crossToPants, index, null)).toEqual({
      price: 53.63,
      basis: "ratio",
    });
  });

  it("clamps the ratio at 1 so a replacement never exceeds its list price", () => {
    // Original has since been marked down BELOW what was paid: 42.75 / 30 = 1.425
    const markedDown = [
      product("15296978026822", [
        { id: "55598268973382", price: "30.00" },
        { id: "55598268940614", price: "30.00" },
      ]),
      PANTS,
    ];
    const index = indexCatalogue(markedDown);
    expect(replacementPrice(crossToPants, index, null)).toEqual({
      price: 69.0,
      basis: "ratio",
    });
  });
});

describe("the bare-id trap", () => {
  it("resolves a BARE original variant_id against GID catalogue keys", () => {
    const index = indexCatalogue(CATALOGUE);
    // If variantGid() were missing, this returns null and every cross-product
    // line silently degrades to the median/none fallback.
    expect(lineRatio(franCrewneck, index)).toBeCloseTo(42.75 / 55.0, 6);
  });
});

describe("fallbacks when the original variant has left the catalogue", () => {
  const orphan: PricedLine = {
    productId: "99999999",
    variant_id: "88888888", // not in the catalogue
    new_variant_id: vgid("54623384404294"),
    price: "40.00",
  };

  it("reports basis 'median' and uses the order's median ratio", () => {
    const index = indexCatalogue(CATALOGUE);
    const fallback = orderRatio([franCrewneck, franPants, orphan], index);
    // ratios: 42.75/55 = 0.777272, 47.03/69 = 0.681594 -> median = 0.729433
    expect(fallback).toBeCloseTo((42.75 / 55.0 + 47.03 / 69.0) / 2, 6);
    expect(replacementPrice(orphan, index, fallback)).toEqual({
      price: 50.33,
      basis: "median",
    });
  });

  it("reports basis 'none' and charges list price when nothing resolves", () => {
    const index = indexCatalogue(CATALOGUE);
    expect(replacementPrice(orphan, index, null)).toEqual({
      price: 69.0,
      basis: "none",
    });
  });

  it("returns the paid price when the REPLACEMENT cannot be priced", () => {
    const index = indexCatalogue([]);
    expect(replacementPrice(franPants, index, null)).toEqual({
      price: 47.03,
      basis: "paid",
    });
  });
});

describe("lines with no replacement chosen", () => {
  it("prices at what was paid", () => {
    const index = indexCatalogue(CATALOGUE);
    const plain: PricedLine = { ...franPants, new_variant_id: null };
    expect(replacementPrice(plain, index, null)).toEqual({
      price: 47.03,
      basis: "paid",
    });
  });
});

describe("replacementPriceForVariant — the picker", () => {
  it("prices a candidate variant the customer has not chosen yet", () => {
    const index = indexCatalogue(CATALOGUE);
    // Same product: what he paid, not the EUR 55 list price on screen today.
    expect(
      replacementPriceForVariant(
        franCrewneck,
        vgid("55598268940614"),
        index,
        null
      ).price
    ).toBe(42.75);
    // Different product: his own depth carried across.
    expect(
      replacementPriceForVariant(
        franCrewneck,
        vgid("54623384404294"),
        index,
        null
      ).price
    ).toBe(53.63);
  });
});

describe("orderRatio", () => {
  it("is null when no line resolves", () => {
    expect(orderRatio([], indexCatalogue(CATALOGUE))).toBeNull();
  });

  it("takes the middle value for an odd number of lines", () => {
    const index = indexCatalogue(CATALOGUE);
    const half: PricedLine = { ...franPants, price: "34.50" }; // 0.5
    const ratio = orderRatio([franCrewneck, franPants, half], index);
    expect(ratio).toBeCloseTo(47.03 / 69.0, 6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/replacementPricing.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/replacementPricing"`.

- [ ] **Step 3: Write the implementation**

Create `lib/replacementPricing.ts`:

```ts
// What a replacement garment costs the customer.
//
// Pure — no db, no env, no network — so it is unit-testable and safe to import
// from a client component. The server-only wrapper is lib/loadBasket.ts.
//
// This replaces `applyGlobalDiscount`, which derived ONE discount ratio from
// `order.products[0]` and rewrote the whole catalogue with it. That made a
// replacement's price a property of the catalogue rather than of the pairing
// it belongs to, so every line after the first was mispriced whenever an order
// carried different markdown depths. Order #311749 paid 22.3% off one garment
// and 31.8% off another and was asked for EUR 6.60 to change both sizes.
import { variantGid } from "@/lib/shopifyIds";
import type { Product } from "@/types";

/**
 * How a price was arrived at.
 *
 * - `paid`   the line's own paid price, verbatim. Same-product size swaps.
 * - `ratio`  the line's own discount depth applied to a different garment.
 * - `median` the order's median depth, because this line's original variant
 *            has left the catalogue.
 * - `none`   list price: nothing in the order resolved. Degraded.
 *
 * `median` and `none` are degraded. This module cannot alert — alertOps is a
 * server action — so it reports the basis and the server-side caller decides.
 */
export type PricingBasis = "paid" | "ratio" | "median" | "none";

export type PricedResult = { price: number; basis: PricingBasis };

/** The fields of a productsorder row this module needs. */
export type PricedLine = {
  productId: string;
  variant_id: string;
  new_variant_id: string | null;
  price: string;
};

export type CatalogueIndex = {
  priceOf(variantId: string | null | undefined): number | null;
  /** The BARE product id owning a variant, to compare against `productId`. */
  productOf(variantId: string | null | undefined): string | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function indexCatalogue(catalogue: Product[]): CatalogueIndex {
  const price = new Map<string, number>();
  const owner = new Map<string, string>();

  for (const product of catalogue) {
    const bareProductId = product.id.split("/").pop() ?? "";
    for (const edge of product.variants.edges) {
      const parsed = parseFloat(edge.node.price);
      if (Number.isFinite(parsed)) price.set(edge.node.id, parsed);
      owner.set(edge.node.id, bareProductId);
    }
  }

  // Keys are GIDs. Callers may hand us either shape, so normalise on the way
  // in: `productsorder.variant_id` is bare while `new_variant_id` is a GID,
  // and comparing the two shapes directly is how this silently returns null
  // for every original variant in the system.
  const key = (id: string | null | undefined) => variantGid(id);

  return {
    priceOf: (id) => {
      const k = key(id);
      return k === null ? null : price.get(k) ?? null;
    },
    productOf: (id) => {
      const k = key(id);
      return k === null ? null : owner.get(k) ?? null;
    },
  };
}

/**
 * How much less than today's list price this line was paid, as a factor in
 * (0, 1]. Null when the original variant is no longer in the catalogue.
 *
 * Clamped at 1: a ratio above 1 means the garment has been marked down below
 * what the customer paid, and multiplying a replacement's list price by it
 * would charge more than the replacement is worth.
 */
export function lineRatio(
  line: PricedLine,
  index: CatalogueIndex
): number | null {
  const paid = parseFloat(line.price);
  const listNow = index.priceOf(line.variant_id);
  if (!Number.isFinite(paid) || listNow === null || listNow <= 0) return null;
  const ratio = paid / listNow;
  if (!(ratio > 0)) return null;
  return Math.min(1, ratio);
}

/**
 * The order's median discount depth, for lines whose own original variant has
 * left the catalogue. Median rather than mean so one archived oddity cannot
 * drag the whole order's pricing.
 */
export function orderRatio(
  lines: PricedLine[],
  index: CatalogueIndex
): number | null {
  const ratios = lines
    .map((line) => lineRatio(line, index))
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);

  if (ratios.length === 0) return null;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 1
    ? ratios[mid]
    : (ratios[mid - 1] + ratios[mid]) / 2;
}

/**
 * Price `newVariantId` as a replacement for `line`.
 *
 * A same-product swap short-circuits to the paid price before any catalogue
 * arithmetic happens. That is the whole fix: a customer changing size cannot
 * be charged, whatever the catalogue has done since they ordered.
 */
export function replacementPriceForVariant(
  line: PricedLine,
  newVariantId: string | null,
  index: CatalogueIndex,
  fallbackRatio: number | null
): PricedResult {
  const paid = round2(parseFloat(line.price) || 0);

  if (!newVariantId) return { price: paid, basis: "paid" };

  const newOwner = index.productOf(newVariantId);
  if (newOwner !== null && newOwner === String(line.productId)) {
    return { price: paid, basis: "paid" };
  }

  const listNow = index.priceOf(newVariantId);
  // We cannot price what we cannot find. Falling back to the paid price keeps
  // the basket at zero rather than inventing a charge from nothing.
  if (listNow === null) return { price: paid, basis: "paid" };

  const own = lineRatio(line, index);
  if (own !== null) return { price: round2(listNow * own), basis: "ratio" };

  if (fallbackRatio !== null) {
    return { price: round2(listNow * fallbackRatio), basis: "median" };
  }

  return { price: round2(listNow), basis: "none" };
}

/** Price the replacement this line has already chosen. */
export function replacementPrice(
  line: PricedLine,
  index: CatalogueIndex,
  fallbackRatio: number | null
): PricedResult {
  return replacementPriceForVariant(
    line,
    line.new_variant_id,
    index,
    fallbackRatio
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/replacementPricing.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/replacementPricing.ts tests/replacementPricing.test.ts
git commit -m "feat: price an exchange replacement per line, not per catalogue

A same-product size swap now returns the line's own paid price without
touching the catalogue. Cross-product exchanges carry that line's own
discount depth. Pure module, so the basis of each price is returned
rather than alerted on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rewire the basket and delete `applyGlobalDiscount`

**Files:**
- Modify: `lib/basket.ts` (delete `applyGlobalDiscount`, rewrite `valueBasket`'s CAMBIO branch)
- Modify: `lib/loadBasket.ts:13-16`
- Modify: `app/[id]/page.tsx:72-80,123`
- Test: `tests/basket.test.ts` (create)

**Interfaces:**
- Consumes: `indexCatalogue`, `orderRatio`, `replacementPrice`, `PricedLine` from Task 1.
- Produces: `valueBasket(items, catalogue)` keeps its **existing signature** — same `Product[]` parameter, same return shape plus one new field `degraded: boolean`. Callers pass the **raw** catalogue instead of a pre-discounted one; no call site changes its arguments.

- [ ] **Step 1: Write the failing test**

Create `tests/basket.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { valueBasket } from "@/lib/basket";
import type { OrderItem, Product } from "@/types";

const vgid = (n: string) => `gid://shopify/ProductVariant/${n}`;

function product(id: string, variants: { id: string; price: string }[]): Product {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `P${id}`,
    handle: `p${id}`,
    description: "",
    images: { edges: [] },
    image: { src: "" },
    variants: {
      edges: variants.map((v) => ({
        node: {
          id: vgid(v.id),
          price: v.price,
          title: v.id,
          inventoryQuantity: 5,
          grams: 400,
        },
      })),
    },
  };
}

const CATALOGUE = [
  product("15296978026822", [
    { id: "55598268973382", price: "55.00" },
    { id: "55598268940614", price: "55.00" },
  ]),
  product("14958568177990", [
    { id: "54623384437062", price: "69.00" },
    { id: "54623384404294", price: "69.00" },
  ]),
];

/** Only the fields valueBasket reads; the rest of the row is irrelevant. */
const line = (o: Partial<OrderItem>) =>
  ({
    action: "CAMBIO",
    confirmed: false,
    quantity: 1,
    ...o,
  }) as OrderItem;

describe("valueBasket — order #311749", () => {
  it("owes nothing for two same-product size swaps at different sale depths", () => {
    const items = [
      line({
        productId: "15296978026822",
        variant_id: "55598268973382",
        new_variant_id: vgid("55598268940614"),
        price: "42.75",
      }),
      line({
        productId: "14958568177990",
        variant_id: "54623384437062",
        new_variant_id: vgid("54623384404294"),
        price: "47.03",
      }),
    ];

    const basket = valueBasket(items, CATALOGUE);

    expect(basket.returnPrice).toBeCloseTo(89.78, 2);
    expect(basket.exchangePrice).toBeCloseTo(89.78, 2);
    // The bug charged EUR 6.60 here.
    expect(basket.netAmount).toBeCloseTo(0, 2);
    expect(basket.degraded).toBe(false);
  });

  it("still weighs the ORIGINAL garments, not the replacements", () => {
    const items = [
      line({
        productId: "15296978026822",
        variant_id: "55598268973382",
        new_variant_id: vgid("55598268940614"),
        price: "42.75",
      }),
    ];
    expect(valueBasket(items, CATALOGUE).grams).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/basket.test.ts`
Expected: FAIL — `netAmount` is `-6.6` (the bug), and `degraded` is `undefined`.

- [ ] **Step 3: Rewrite `lib/basket.ts`**

Delete the entire `applyGlobalDiscount` function and its docblock (`lib/basket.ts:12-53`). Replace the import line and the `valueBasket` body:

```ts
import type { OrderItem, Product, ProductVariant } from "@/types";
import {
  indexCatalogue,
  orderRatio,
  replacementPrice,
  type PricedLine,
} from "@/lib/replacementPricing";
```

`parcelGrams` and `FALLBACK_ITEM_GRAMS` are unchanged — they read weights, not prices. Replace `valueBasket` with:

```ts
/**
 * Value a basket the same way every client component does: everything with an
 * action counts toward the return total; CAMBIO lines subtract the price of
 * their replacement.
 *
 * `discountedProducts` used to arrive pre-mutated by `applyGlobalDiscount`.
 * It now arrives RAW, and each replacement is priced against the line it
 * replaces — see lib/replacementPricing.ts for why.
 */
export function valueBasket(
  items: OrderItem[],
  catalogue: Product[]
): {
  returnPrice: number;
  exchangePrice: number;
  netAmount: number;
  hasItems: boolean;
  grams: number;
  degraded: boolean;
} {
  const active = items.filter((item) => item.action && !item.confirmed);
  const index = indexCatalogue(catalogue);
  const fallbackRatio = orderRatio(items as unknown as PricedLine[], index);

  const returnPrice = active.reduce(
    (sum, item) => sum + parseFloat(item.price),
    0
  );

  let degraded = false;
  const exchangePrice = active
    .filter((item) => item.action === "CAMBIO")
    .reduce((sum, item) => {
      const priced = replacementPrice(
        item as unknown as PricedLine,
        index,
        fallbackRatio
      );
      // The server-side caller alerts on this; a pure module cannot.
      if (priced.basis === "median" || priced.basis === "none") degraded = true;
      return sum + priced.price;
    }, 0);

  return {
    returnPrice,
    exchangePrice,
    netAmount: returnPrice - exchangePrice,
    hasItems: active.length > 0,
    grams: parcelGrams(active, catalogue),
    degraded,
  };
}
```

- [ ] **Step 4: Stop pre-discounting in the two server callers**

`lib/loadBasket.ts` — replace the body of `loadBasket`:

```ts
import { getOrderById, getProducts } from "@/db/queries";
import { valueBasket } from "@/lib/basket";
import type { OrderItem } from "@/types";

/** Load an order and value its basket. Returns null if the order is gone. */
export async function loadBasket(orderId: string) {
  const order = await getOrderById(orderId);
  if (!order) return null;

  // The catalogue is passed through RAW. Replacement prices are derived per
  // line by lib/replacementPricing.ts, so nothing here rewrites a price.
  const catalogue = await getProducts();
  const basket = valueBasket(order.products as OrderItem[], catalogue);

  return { order, discountedProducts: catalogue, basket };
}
```

`app/[id]/page.tsx` — delete the `applyGlobalDiscount` import (line 4) and replace lines 78-80:

```ts
  // Raw catalogue. Replacement prices are per-line; see lib/replacementPricing.ts.
  const discountedAllProducts = allProducts;
```

Leave the `discountedAllProducts` name and the `allProducts={discountedAllProducts}` prop at line 123 alone — Task 3 renames them, and keeping this step to a behaviour change makes the diff reviewable.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/fees.test.ts` imports `valueBasket` and must still pass — the signature is unchanged and `degraded` is additive.

- [ ] **Step 6: Verify the old function is gone**

Run: `grep -rn "applyGlobalDiscount" --include='*.ts' --include='*.tsx' . | grep -v node_modules`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add lib/basket.ts lib/loadBasket.ts "app/[id]/page.tsx" tests/basket.test.ts
git commit -m "fix: stop pricing exchanges with another line's discount ratio

valueBasket now prices each replacement against the line it replaces and
takes the catalogue raw. Order #311749 goes from a EUR 6.60 charge to
zero. applyGlobalDiscount is deleted.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Make the on-screen prices agree with the charge

**Files:**
- Modify: `app/[id]/components/summary/summaryLine.tsx:55-70`
- Modify: `app/[id]/components/summary/summary.tsx:113-121,188-194`
- Modify: `app/[id]/components/productLineClient.tsx:155-160`
- Modify: `app/[id]/components/dialogForm.tsx:480-490`
- Modify: `app/[id]/windows/thirdWindow.tsx:180-205`

**Interfaces:**
- Consumes: `indexCatalogue`, `orderRatio`, `replacementPriceForVariant`, `replacementPrice`, `PricedLine` from Task 1; `valueBasket` from Task 2.
- Produces: no new exports. Every rendered replacement price comes from `replacementPriceForVariant`.

- [ ] **Step 1: Delete the duplicated valuation in `thirdWindow.tsx`**

`app/[id]/windows/thirdWindow.tsx:180-205` re-implements `valueBasket` inline. Replace the whole `totalPrice` memo body with a call to the shared one:

```ts
  const totalPrice = useMemo(() => {
    const basket = valueBasket(items, allProducts);
    let result = basket.netAmount;
    const { feeCents } = resolveFee(fees, {
      hasItems: basket.hasItems,
      netAmount: result,
      grams: basket.grams,
    });
    if (shipping) result -= centsToEuros(feeCents);
    return result;
  }, [allProducts, items, shipping, fees]);
```

Add `valueBasket` to the existing `@/lib/basket` import and drop `parcelGrams` if it becomes unused.

- [ ] **Step 2: Price the summary rows per line**

`app/[id]/components/summary/summaryLine.tsx:62-64` currently reads:

```tsx
          price={
            newProduct ? newProduct.variants.edges[0]?.node.price : item.price
          }
```

That takes the **first variant of the new product**, not the chosen one. Change `SummaryLine` to accept a resolved price instead of a `Product`. In `summaryLine.tsx`, replace the `newProduct: Product | null` prop with `newPrice: number | null` and render:

```tsx
          price={newPrice !== null ? String(newPrice) : item.price}
```

In `summary.tsx`, delete `findProductByVariantId` (lines 113-121) and add, inside the existing `useMemo` that already calls `valueBasket`:

```ts
    const index = indexCatalogue(allProducts);
    const fallbackRatio = orderRatio(items as unknown as PricedLine[], index);
    const priceFor = (item: OrderItem) =>
      replacementPrice(item as unknown as PricedLine, index, fallbackRatio).price;
```

Return `priceFor` from the memo alongside `basket`, and change the render at line 188-194 to:

```tsx
              <SummaryLine
                key={item.id}
                item={item}
                newAction={true}
                newPrice={priceFor(item)}
              />
```

- [ ] **Step 3: Price the exchange line in `productLineClient.tsx`**

Line 158 reads `{newVariant} - {newProduct.variants.edges[0]?.node.price || ""} €`. Replace with the per-line price:

```tsx
            {newVariant} -{" "}
            {replacementPrice(
              orderProduct as unknown as PricedLine,
              indexCatalogue(allProducts),
              null
            ).price}{" "}
            €
```

- [ ] **Step 4: Price the picker dropdown in `dialogForm.tsx`**

At line ~485 the dropdown computes `const price = firstVariant?.price || "";`. With a raw catalogue this now shows list price — €55 for a garment the customer will receive for €42.75. Replace with:

```tsx
                        const firstVariant = p.variants.edges[0]?.node;
                        const price = firstVariant
                          ? String(
                              replacementPriceForVariant(
                                orderProduct as unknown as PricedLine,
                                firstVariant.id,
                                catalogueIndex,
                                null
                              ).price
                            )
                          : "";
```

Hoist the index above the JSX so it is not rebuilt per row:

```ts
  const catalogueIndex = useMemo(() => indexCatalogue(allProducts), [allProducts]);
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit -p tsconfig.json`
Expected: tests PASS, no type errors.

- [ ] **Step 6: Verify no display site reads a bare catalogue price for a replacement**

Run: `grep -rn "variants.edges\[0\]?.node.price" --include='*.tsx' app/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add "app/[id]"
git commit -m "fix: show the exchange price the customer will actually be charged

The summary rows, the exchange line and the product picker each read a
replacement price from lib/replacementPricing instead of the catalogue,
and thirdWindow drops its copy of valueBasket.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Alert when pricing degrades

**Files:**
- Modify: `actions/payments.ts:48-60`
- Test: `tests/basket.test.ts` (extend)

**Interfaces:**
- Consumes: `basket.degraded` from Task 2; `alertOps` from `@/actions/opsAlert`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/basket.test.ts`:

```ts
describe("valueBasket degradation reporting", () => {
  it("flags a basket whose original variant has left the catalogue", () => {
    const items = [
      line({
        productId: "99999999",
        variant_id: "88888888",
        new_variant_id: vgid("54623384404294"),
        price: "40.00",
      }),
    ];
    expect(valueBasket(items, CATALOGUE).degraded).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/basket.test.ts`
Expected: FAIL if Task 2's `degraded` wiring is wrong; PASS if correct — this test guards Task 2's contract, so a pass here is the expected outcome and the step is a verification, not a red-green cycle.

- [ ] **Step 3: Alert in `createStripeUrl` before charging**

In `actions/payments.ts`, add the import and insert after the `const { order, basket } = loaded;` line:

```ts
import { alertOps } from "@/actions/opsAlert";

  // A degraded basket means at least one replacement was priced from the
  // order's median discount depth, or from list price, because its original
  // variant is no longer in the catalogue. That has never happened in
  // production (0 of 289 exchange lines) — so if it does, we want to hear
  // about it before the customer is charged, not after.
  if (basket.degraded) {
    await alertOps(
      "EXCHANGE PRICED ON A FALLBACK",
      `Order ${id}: a replacement could not be priced from its own line. ` +
        `Charge derived from a fallback ratio. Check before refunding.`
    );
  }
```

Match `alertOps`' actual signature — read `actions/opsAlert.ts` first and adapt the call rather than assuming two string arguments.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add actions/payments.ts tests/basket.test.ts
git commit -m "feat: alert when an exchange is priced from a fallback ratio

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Fix the two latent bugs the spec identified

**Files:**
- Modify: `utils/order-utils.ts:40-42`
- Modify: `db/queries.ts:1288`
- Test: `tests/orderUtils.test.ts` (create, or extend if a file already covers `utils/order-utils.ts`)

**Interfaces:**
- Consumes: `OrderLineItem` from `@/types`.
- Produces: `calculatePriceWithDiscount(item: OrderLineItem): number` — same signature, corrected arithmetic.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { calculatePriceWithDiscount } from "@/utils/order-utils";
import type { OrderLineItem } from "@/types";

const item = (o: Partial<OrderLineItem>) => o as OrderLineItem;

describe("calculatePriceWithDiscount", () => {
  it("returns the unit price when there is no discount", () => {
    expect(
      calculatePriceWithDiscount(item({ price: "55.00", quantity: 1 }))
    ).toBeCloseTo(55.0, 2);
  });

  it("subtracts a single allocation from a single unit", () => {
    expect(
      calculatePriceWithDiscount(
        item({
          price: "55.00",
          quantity: 1,
          discount_allocations: [{ amount: "2.75" }],
        } as Partial<OrderLineItem>)
      )
    ).toBeCloseTo(52.25, 2);
  });

  it("divides a LINE-TOTAL allocation across the quantity", () => {
    // Shopify allocates against the line, not the unit. Two units at EUR 55
    // with a 5% code allocate EUR 5.50 to the line; the unit paid EUR 52.25.
    expect(
      calculatePriceWithDiscount(
        item({
          price: "55.00",
          quantity: 2,
          discount_allocations: [{ amount: "5.50" }],
        } as Partial<OrderLineItem>)
      )
    ).toBeCloseTo(52.25, 2);
  });

  it("sums every allocation, not just the first", () => {
    expect(
      calculatePriceWithDiscount(
        item({
          price: "55.00",
          quantity: 1,
          discount_allocations: [{ amount: "2.75" }, { amount: "5.00" }],
        } as Partial<OrderLineItem>)
      )
    ).toBeCloseTo(47.25, 2);
  });

  it("never returns a negative unit price", () => {
    expect(
      calculatePriceWithDiscount(
        item({
          price: "10.00",
          quantity: 1,
          discount_allocations: [{ amount: "99.00" }],
        } as Partial<OrderLineItem>)
      )
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/orderUtils.test.ts`
Expected: FAIL on the quantity and multi-allocation cases (`49.50` instead of `52.25`; `52.25` instead of `47.25`).

- [ ] **Step 3: Fix the implementation**

Replace `utils/order-utils.ts:40-42`:

```ts
/**
 * The per-unit price the customer actually paid.
 *
 * Shopify's `discount_allocations[].amount` is allocated against the LINE, not
 * the unit, and a line can carry more than one allocation (an automatic
 * discount stacked on a code). Subtracting only `[0]` from a unit price is
 * wrong on both counts. Latent until now — no qty>1 discounted line existed in
 * the last 250 orders — but this number is what every exchange is priced from.
 */
export function calculatePriceWithDiscount(item: OrderLineItem): number {
  const unit = Number(item.price) || 0;
  const quantity = Math.max(1, Number(item.quantity) || 1);
  const allocated = (item.discount_allocations ?? []).reduce(
    (sum, allocation) => sum + (Number(allocation.amount) || 0),
    0
  );
  return Math.max(0, unit - allocated / quantity);
}
```

- [ ] **Step 4: Raise the variant page size**

`db/queries.ts:1288` — change `variants(first: 10)` to `variants(first: 50)`. No active product exceeds 10 variants today, but one with more sizes would silently lose them from the picker.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add utils/order-utils.ts db/queries.ts tests/orderUtils.test.ts
git commit -m "fix: divide line-total discounts across the quantity, sum every allocation

calculatePriceWithDiscount subtracted a LINE-total allocation from a UNIT
price and read only the first allocation. Latent - no qty>1 discounted
line in the last 250 orders - but it is the number every exchange price
is derived from. Also raises the variant page size from 10 to 50.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The exact historical audit

**Files:**
- Create: `scripts/audit-exchange-overcharges.ts`

**Interfaces:**
- Consumes: `DATABASE_URL`, `STRIPE_SECRET_KEY` from the environment; `indexCatalogue` from Task 1.
- Produces: a CSV on stdout — `order_id,order_number,email,charged_difference_eur,lines`.

**This task is read-only. It writes nothing to the database, Stripe, or Shopify.**

- [ ] **Step 1: Write the script**

The query needs no historical catalogue prices, which is what makes it exact. Under the Task 1 rule an all-same-product exchange owes **exactly €0**, so any such order carrying a Stripe `difference` line item was overcharged by that line's amount.

```ts
// Read-only. Lists orders whose exchange was entirely same-product size swaps
// but which were nonetheless charged a price difference.
//
// Exact, unlike a catalogue reconstruction: the correct charge for an
// all-same-product exchange is zero regardless of what the catalogue said at
// the time, so the Stripe `difference` line IS the overcharge.
import db from "@/db/drizzle";
import { productsOrder, orders } from "@/db/schema";
import { getProducts } from "@/db/queries";
import { indexCatalogue } from "@/lib/replacementPricing";
import { stripe } from "@/lib/stripe";
import { eq } from "drizzle-orm";

async function main() {
  const index = indexCatalogue(await getProducts());
  const rows = await db.select().from(productsOrder);

  const byOrder = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.orderId) continue;
    const list = byOrder.get(row.orderId) ?? [];
    list.push(row);
    byOrder.set(row.orderId, list);
  }

  const candidates: string[] = [];
  for (const [orderId, lines] of byOrder) {
    const swaps = lines.filter(
      (l) => l.action === "CAMBIO" && l.new_variant_id
    );
    if (swaps.length === 0) continue;
    // Every chosen replacement must belong to the line's own product.
    const allSameProduct = swaps.every(
      (l) => index.productOf(l.new_variant_id) === String(l.productId)
    );
    if (allSameProduct) candidates.push(orderId);
  }

  console.log("order_id,order_number,email,charged_difference_eur");
  for (const orderId of candidates) {
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      expand: ["data.line_items"],
    });
    const session = sessions.data.find(
      (s) => s.metadata?.id === orderId && s.payment_status === "paid"
    );
    if (!session) continue;

    // "difference" is the first checkoutLines kind; its Stripe label is
    // t.summary.newProducts. Match on amount decomposition rather than the
    // localised label: the difference line is the one that is NOT a fee.
    const items = session.line_items?.data ?? [];
    const difference = items.find(
      (li) => !/shipping|env[ií]o|fee/i.test(li.description ?? "")
    );
    if (!difference || !difference.amount_total) continue;

    const order = await db.query.orders.findFirst({
      where: eq(orders.id, orderId),
    });
    console.log(
      [
        orderId,
        order?.orderNumber ?? "",
        order?.email ?? "",
        (difference.amount_total / 100).toFixed(2),
      ].join(",")
    );
  }
}

main().then(() => process.exit(0));
```

- [ ] **Step 2: Run it**

Run: `npx tsx --tsconfig tsconfig.scripts.json scripts/audit-exchange-overcharges.ts | tee /tmp/exchange-overcharges.csv`
Expected: a CSV. If `getProducts` fails outside the Next runtime because of React `cache()`, move the script behind a temporary API route — never one with a `_` prefix — as recorded in the `pilar-311198-undiscovered-outage-victim` note.

- [ ] **Step 3: Hand the numbers over**

Do **not** issue refunds. Report the list, the row count and the euro total, and stop. Whether and how to refund is Santiago's call.

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-exchange-overcharges.ts
git commit -m "chore: read-only audit for exchanges overcharged a price difference

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Make order #311749 whole

**Files:** none — this is a verification and a customer action.

- [ ] **Step 1: Verify against the real order on a local dev server**

Deploy the branch to a Vercel preview, or run `next dev` locally. **Preview shares the production database** (`preview-shares-production-database` note), so treat anything you click as a live customer order and do not confirm a return.

Open `/311749` and confirm the summary shows **€0.00** for the two size swaps, plus whatever return shipping fee genuinely applies.

- [ ] **Step 2: Confirm the Stripe amount agrees**

With both lines set to CAMBIO and the smaller sizes chosen, `createStripeUrl` must return `{ data: null }` — no payment required — for a basket whose only cost is a €0 difference, or a session for the shipping fee alone. Check the server log rather than clicking through to Stripe.

- [ ] **Step 3: Reply to Fran**

He was told to pay €6.60 to change two sizes and declined. Once the fix is live, tell him the exchange now costs nothing and he can complete it in the portal. Draft the reply for Santiago to send — **do not send email directly**.

- [ ] **Step 4: Whole-branch review**

Before merging, run a review over the **entire branch diff**, not per task. This bug's shape — one pricing rule with many collection points — is exactly the shape that twelve per-task reviews missed in the `return-fee-two-collection-points` incident and that only a whole-branch review caught in `auto-approve-cron-branch`.

Run: `/code-review high`

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| The rule, steps 1-3 | Task 1 |
| Pure module, `basis` instead of `alertOps` | Task 1 (return type), Task 4 (the alert) |
| The id-shape trap | Task 1, `indexCatalogue` key normalisation + its dedicated test |
| Call sites: `loadBasket`, `page.tsx`, `valueBasket` | Task 2 |
| Call sites: `thirdWindow`, `summary`, `summaryLine`, `productLineClient`, `dialogForm` | Task 3 |
| `createStripeUrl` needs no amount change | Task 2 (verified by `tests/fees.test.ts` still passing); Task 4 adds only the alert |
| `applyGlobalDiscount` deleted | Task 2, Step 6 |
| Riding along: `calculatePriceWithDiscount`, `variants(first: 10)` | Task 5 |
| Testing: #311749 regression, same-product property, clamp, fallback, `variantGid` | Task 1 Step 1, Task 2 Step 1 |
| Phase 3, exact historical audit | Task 6 |
| Phase 4, #311749 made whole | Task 7 |
| No migration, no backfill | Global Constraints |
| Open decision: the cross-product branch | Task 1 Step 3 ships a default; see Handoff below |

**Type consistency:** `PricedLine` is used identically in Tasks 1, 2, 3 and 6. `valueBasket` returns the same six fields everywhere it is described. `replacementPriceForVariant` takes `(line, newVariantId, index, fallbackRatio)` in every task that calls it. `SummaryLine`'s prop is `newPrice: number | null` in both the definition and the call site.

**Known soft spots, deliberately left to the implementer:**
- `alertOps`' signature is not reproduced here. Task 4 Step 3 says to read `actions/opsAlert.ts` and adapt rather than assume.
- Task 6's Stripe line-item match uses a negative regex on a localised description. If `checkoutLines` metadata offers a cleaner discriminator, prefer it — the audit's accuracy matters more than the shape of this script.
