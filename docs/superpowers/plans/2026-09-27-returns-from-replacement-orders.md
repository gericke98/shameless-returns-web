# Returns from Replacement Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A garment returned from one of our replacement (exchange) orders is valued at what the customer paid on the original order, and a card refund is paid against the original order's real payment — never against the €0.01 placeholder, never twice.

**Architecture:** On first portal lookup, an order tagged `Change` + `Order #NNN` is linked to its original through a new `orders.exchange_of` column and each line is priced from the original's matching exchange row (fail closed otherwise). Return creation stores the ROOT order's refundable transaction. Settlement's refund lane, for linked orders, moves money on the root with an idempotency marker, marks the row paid at once, then books the goods back on the replacement. A one-off script repairs the 4 unsettled historical rows.

**Tech Stack:** Next.js 14 server actions, Drizzle ORM on Neon Postgres, Shopify Admin GraphQL 2025-01 (+ REST 2024-04 for order lookup), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-returns-from-replacement-orders-design.md`

**Spec amendment (made while planning, flag it in review):** the spec says `exchange_of` stores the ROOT. This plan stores the **immediate original** and resolves the root by walking `exchange_of` links (`resolveRootOrderId`). Reason: the top-up alert (spec §3) needs the immediate original, and storing only the root would lose it on chains. Every consumer that needs money uses the resolved root, so behaviour matches the spec.

## Global Constraints

- Test command (the default `npm test` is non-deterministic): `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
- Tests live in `tests/*.test.ts`; server modules are mocked with `vi.mock` as in `tests/settleRefundTransactionGuard.test.ts` (including the `react` `cache` shim).
- `productsorder.variant_id` is BARE, `new_variant_id` is a full GID — compare only through `variantGid()` from `lib/shopifyIds.ts`.
- Return-leg rule is unchanged: refund = `price − 5`, or `price − 0` when `orders.return_method = 'SELF'`.
- Never fall back to list price for a replacement order line. Fail closed + `alertOps`.
- Migration is applied by hand on database `ShamelessReturns` BEFORE deploy and verified with `information_schema` (PR #38 outage).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Money moved, booking failed, cron runs again next morning** → no second refund (row flag AND root-order marker both protect). Pinned in Task 5 + Task 6.
2. **A replacement of a replacement** (#A → #B → #C) → price from #B's row, money from #A. Pinned in Task 2 (`resolveRootOrderId`) and Task 6.
3. **An order tagged `Change` whose original is missing from our DB, or whose line matches zero / two original rows** → portal refuses with the contact message and alerts; nothing saved at list price. Pinned in Task 2 + Task 3.
4. **Non-EUR root order** → the root refund is converted with the root order's presentment rate, not EUR at par. Pinned in Task 5.
5. **An ordinary (non-replacement) order** → every path byte-for-byte unchanged. Pinned in Task 3, Task 4, Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `drizzle/0003_exchange_of.sql` (create) | Additive nullable column |
| `db/schema.ts` (modify) | `exchangeOf` on `orders` |
| `types/index.ts` (modify) | `tags?: string` on `OrderData` |
| `lib/replacementOrigin.ts` (create) | PURE: tag parsing, line matching, pricing plan, root walk, product-swap check |
| `actions/replacementOrder.ts` (create) | Server: loads the original from the DB and runs the pure planner |
| `actions/order.ts` (modify) | Lookup: fail closed or save with corrected prices + `exchangeOf` |
| `db/repository.ts` (modify) | `saveOrderDetails` accepts `exchangeOf` |
| `db/queries.ts` (modify) | `getOrderTransactions`, `refundOnOrder` |
| `actions/updateOrder.ts` (modify) | Store root order's transaction on linked orders |
| `lib/settleReturn.ts` (modify) | Two-order refund lane + top-up alert |
| `scripts/repair-replacement-order-rows.ts` (create) | One-off, dry-run by default |

---

### Task 1: Column, schema, type

**Files:**
- Create: `drizzle/0003_exchange_of.sql`
- Modify: `db/schema.ts` (orders table, after `stripePaymentIntent`)
- Modify: `types/index.ts:81-100` (`OrderData`)

**Interfaces:**
- Produces: `orders.exchangeOf: string | null` (Drizzle), `OrderData.tags?: string`

- [ ] **Step 1: Write the migration**

```sql
-- The order this one REPLACES, when it is one of our exchange orders.
--
-- Null means "an ordinary purchase", which is every existing row, so no
-- backfill is needed for correctness; scripts/repair-replacement-order-rows.ts
-- sets it on the few replacement orders already looked up. Points at the
-- IMMEDIATE original; code walks the chain to the root, where the money is.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "exchange_of" text;
```

- [ ] **Step 2: Add the column to the schema** (after `stripePaymentIntent`)

```ts
  // Set when this order is one of OUR replacement orders (tags `Change` +
  // `Order #NNN`): the id of the order it replaced. Such an order carries only
  // a €0.01 placeholder payment and list prices, so anything that values or
  // refunds its lines must go back through this link. See
  // lib/replacementOrigin.ts.
  exchangeOf: text("exchange_of"),
```

- [ ] **Step 3: Add `tags` to `OrderData`** (after `note?: string;`)

```ts
  /** Comma-separated, as Shopify REST returns it. */
  tags?: string;
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0003_exchange_of.sql db/schema.ts types/index.ts
git commit -m "feat: add orders.exchange_of for replacement orders"
```

---

### Task 2: Pure replacement-origin logic

**Files:**
- Create: `lib/replacementOrigin.ts`
- Test: `tests/replacementOrigin.test.ts`

**Interfaces:**
- Produces:
  - `originalOrderNumberFromTags(tags: string | null | undefined): string | null`
  - `type OriginalRow = { variant_id: string; productId: string; new_variant_id: string | null; action: string | null; confirmed: boolean | null; price: string }`
  - `type ReplacementLine = { variant_id: string | number; product_id: string | number }`
  - `planReplacementPricing(lines: ReplacementLine[], originalRows: OriginalRow[]): { ok: true; priceByVariant: Record<string, string> } | { ok: false; reason: string }` — keys are BARE variant ids
  - `resolveRootOrderId(startId: string, exchangeOfOf: (id: string) => Promise<string | null>): Promise<string>`
  - `wasProductSwap(originalRows: OriginalRow[], replacementVariantId: string, replacementProductId: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  originalOrderNumberFromTags,
  planReplacementPricing,
  resolveRootOrderId,
  wasProductSwap,
} from "@/lib/replacementOrigin";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  variant_id: "54623384437062",
  productId: "14958568177990",
  new_variant_id: "gid://shopify/ProductVariant/54623384404294",
  action: "CAMBIO",
  confirmed: true,
  price: "47.03",
  ...over,
}) as any;

describe("originalOrderNumberFromTags", () => {
  it("reads the original from Change + one Order tag", () => {
    expect(
      originalOrderNumberFromTags("amphora_shipped, APH, Change, Order #311749")
    ).toBe("#311749");
  });
  it("is null without the Change tag", () => {
    expect(originalOrderNumberFromTags("Order #311749")).toBeNull();
  });
  it("is null with two Order tags — ambiguous, not guessed", () => {
    expect(originalOrderNumberFromTags("Change, Order #1, Order #2")).toBeNull();
  });
  it("is null for empty or missing tags", () => {
    expect(originalOrderNumberFromTags("")).toBeNull();
    expect(originalOrderNumberFromTags(undefined)).toBeNull();
  });
});

describe("planReplacementPricing", () => {
  it("prices each line at the matching original row (GID vs bare id)", () => {
    const plan = planReplacementPricing(
      [{ variant_id: 54623384404294, product_id: 14958568177990 }],
      [row()]
    );
    expect(plan).toEqual({ ok: true, priceByVariant: { "54623384404294": "47.03" } });
  });
  it("ignores rows that are not confirmed exchanges", () => {
    const plan = planReplacementPricing(
      [{ variant_id: "54623384404294", product_id: "1" }],
      [row({ action: "DEVOLUCIÓN" }), row({ confirmed: false })]
    );
    expect(plan.ok).toBe(false);
  });
  it("fails closed when a line has no match", () => {
    const plan = planReplacementPricing([{ variant_id: "999", product_id: "1" }], [row()]);
    expect(plan).toEqual({ ok: false, reason: "no-original-line:999" });
  });
  it("fails closed when a line matches two original rows", () => {
    const plan = planReplacementPricing(
      [{ variant_id: "54623384404294", product_id: "1" }],
      [row(), row({ variant_id: "other", price: "50" })]
    );
    expect(plan).toEqual({ ok: false, reason: "ambiguous-original-line:54623384404294" });
  });
  it("fails closed with no lines at all", () => {
    expect(planReplacementPricing([], [row()]).ok).toBe(false);
  });
});

describe("resolveRootOrderId", () => {
  it("walks a chain to the order with no exchange_of", async () => {
    const links: Record<string, string | null> = { C: "B", B: "A", A: null };
    await expect(resolveRootOrderId("C", async (id) => links[id] ?? null)).resolves.toBe("A");
  });
  it("returns the start when it is not linked", async () => {
    await expect(resolveRootOrderId("A", async () => null)).resolves.toBe("A");
  });
  it("throws on a cycle instead of looping", async () => {
    const links: Record<string, string> = { A: "B", B: "A" };
    await expect(resolveRootOrderId("A", async (id) => links[id])).rejects.toThrow(/cycle/);
  });
});

describe("wasProductSwap", () => {
  it("is false for a size swap of the same product", () => {
    expect(wasProductSwap([row()], "54623384404294", "14958568177990")).toBe(false);
  });
  it("is true when the replacement is a different product", () => {
    expect(wasProductSwap([row()], "54623384404294", "15296978026822")).toBe(true);
  });
  it("is false when no original row matches", () => {
    expect(wasProductSwap([row()], "1", "2")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/replacementOrigin.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `@/lib/replacementOrigin`.

- [ ] **Step 3: Implement**

```ts
// Replacement orders: the Shopify orders WE create when an exchange settles.
//
// Pure — no db, no env, no network — because these rules decide what a
// returned garment is worth and which order pays for it.
//
// `createOrder` (db/queries.ts) gives every replacement the tags `Change` and
// `Order #NNN`, a €0.01 `manual` payment, and LIST prices. So a line on a
// replacement order says nothing true about money: its value is the price the
// customer paid on the original order's exchange row, and a refund must go to
// the order that holds the real payment. #312061 (replacement for #311749)
// showed both: €62 list against €47.03 paid, refunded against €0.01.
import { variantGid } from "@/lib/shopifyIds";

// Field names as Drizzle returns `productsorder` rows (camelCase `productId`).
export type OriginalRow = {
  variant_id: string;
  productId: string;
  new_variant_id: string | null;
  action: string | null;
  confirmed: boolean | null;
  price: string;
};

export type ReplacementLine = {
  variant_id: string | number;
  product_id: string | number;
};

const ORDER_TAG = /^Order (#\d+)$/;

/** The original's order number, or null when this is not unambiguously ours. */
export function originalOrderNumberFromTags(
  tags: string | null | undefined
): string | null {
  const list = String(tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!list.includes("Change")) return null;
  const numbers = list
    .map((t) => ORDER_TAG.exec(t)?.[1])
    .filter((n): n is string => !!n);
  return numbers.length === 1 ? numbers[0] : null;
}

function exchangeRowsFor(originalRows: OriginalRow[], variantId: string) {
  const target = variantGid(String(variantId));
  return originalRows.filter(
    (r) =>
      r.action === "CAMBIO" &&
      r.confirmed === true &&
      !!r.new_variant_id &&
      variantGid(r.new_variant_id) === target
  );
}

/**
 * The paid price of every replacement line, or why it cannot be known.
 *
 * All-or-nothing: one unmatched line fails the whole order, because saving the
 * others at the right price and that one at list would still overpay.
 */
export function planReplacementPricing(
  lines: ReplacementLine[],
  originalRows: OriginalRow[]
): { ok: true; priceByVariant: Record<string, string> } | { ok: false; reason: string } {
  if (lines.length === 0) return { ok: false, reason: "no-lines" };
  const priceByVariant: Record<string, string> = {};
  for (const line of lines) {
    const bare = String(line.variant_id);
    const matches = exchangeRowsFor(originalRows, bare);
    if (matches.length === 0) return { ok: false, reason: `no-original-line:${bare}` };
    if (matches.length > 1) return { ok: false, reason: `ambiguous-original-line:${bare}` };
    priceByVariant[bare] = matches[0].price;
  }
  return { ok: true, priceByVariant };
}

/** Follow `exchange_of` links to the order that holds the real payment. */
export async function resolveRootOrderId(
  startId: string,
  exchangeOfOf: (id: string) => Promise<string | null>
): Promise<string> {
  const seen = new Set<string>([startId]);
  let current = startId;
  for (;;) {
    const next = await exchangeOfOf(current);
    if (!next) return current;
    if (seen.has(next)) throw new Error(`exchange_of cycle at order ${next}`);
    seen.add(next);
    current = next;
  }
}

/**
 * Did the customer swap to a DIFFERENT product for this replacement? Only then
 * can they have paid a Stripe top-up that the original line price does not
 * cover. False when nothing matches — the caller has already failed closed.
 */
export function wasProductSwap(
  originalRows: OriginalRow[],
  replacementVariantId: string,
  replacementProductId: string
): boolean {
  const [match] = exchangeRowsFor(originalRows, replacementVariantId);
  return !!match && String(match.productId) !== String(replacementProductId);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/replacementOrigin.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/replacementOrigin.ts tests/replacementOrigin.test.ts
git commit -m "feat: pure rules for valuing lines on a replacement order"
```

---

### Task 3: Portal lookup — fail closed or save corrected prices

**Files:**
- Create: `actions/replacementOrder.ts`
- Modify: `db/repository.ts:28` (`saveOrderDetails`), `db/repository.ts:55` (`saveOrderItem` unchanged — price is passed in)
- Modify: `actions/order.ts` (step 5 of `getOrder`, `saveOrderToDatabase`, `insertOrderItems`)
- Test: `tests/replacementOrderLookup.test.ts`

**Interfaces:**
- Consumes: `originalOrderNumberFromTags`, `planReplacementPricing` (Task 2); `getOrderByNumberFresh(orderNumber)` from `db/queries.ts`; `alertOps(subject, body)`.
- Produces: `planReplacementOrder(order: OrderData): Promise<{ kind: "ordinary" } | { kind: "replacement"; exchangeOf: string; priceByVariant: Record<string, string> } | { kind: "refused"; reason: string }>` in `actions/replacementOrder.ts`; `saveOrderDetails(order: OrderData, exchangeOf?: string | null)`.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORIGINALS: Record<string, any> = {};
vi.mock("@/db/queries", () => ({
  getOrderByNumberFresh: async (n: string) => ORIGINALS[n],
}));
const alerts: string[] = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => { alerts.push(subject); },
}));

const replacement = (tags: string) => ({
  id: 13327059452230,
  name: "#312061",
  tags,
  line_items: [{ variant_id: 54623384404294, product_id: 14958568177990, quantity: 1 }],
}) as any;

beforeEach(() => {
  alerts.length = 0;
  for (const k of Object.keys(ORIGINALS)) delete ORIGINALS[k];
  ORIGINALS["#311749"] = {
    id: "13282550841670",
    products: [{
      variant_id: "54623384437062", productId: "14958568177990",
      new_variant_id: "gid://shopify/ProductVariant/54623384404294",
      action: "CAMBIO", confirmed: true, price: "47.03",
    }],
  };
});

async function plan(order: any) {
  const { planReplacementOrder } = await import("@/actions/replacementOrder");
  return planReplacementOrder(order);
}

describe("planReplacementOrder", () => {
  it("leaves an ordinary order alone and alerts nothing", async () => {
    await expect(plan(replacement("amphora_shipped"))).resolves.toEqual({ kind: "ordinary" });
    expect(alerts).toHaveLength(0);
  });

  it("links a replacement to its original and prices from the paid row", async () => {
    await expect(plan(replacement("Change, Order #311749"))).resolves.toEqual({
      kind: "replacement",
      exchangeOf: "13282550841670",
      priceByVariant: { "54623384404294": "47.03" },
    });
  });

  it("refuses and alerts when the original is not in our DB", async () => {
    const out = await plan(replacement("Change, Order #999999"));
    expect(out).toEqual({ kind: "refused", reason: "original-not-found:#999999" });
    expect(alerts).toHaveLength(1);
  });

  it("refuses and alerts when a line cannot be matched", async () => {
    ORIGINALS["#311749"].products[0].new_variant_id = "gid://shopify/ProductVariant/1";
    const out = await plan(replacement("Change, Order #311749"));
    expect(out.kind).toBe("refused");
    expect(alerts).toHaveLength(1);
  });

  it("ignores zero-quantity lines like the lookup does", async () => {
    const order = replacement("Change, Order #311749");
    order.line_items.push({ variant_id: 1, product_id: 2, quantity: 0 });
    await expect(plan(order)).resolves.toMatchObject({ kind: "replacement" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/replacementOrderLookup.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `@/actions/replacementOrder`.

- [ ] **Step 3: Implement `actions/replacementOrder.ts`**

```ts
// Server-only. Decides, at first portal lookup, whether an order is one of our
// replacement orders and what its lines are really worth. The rules are pure
// and live in lib/replacementOrigin.ts; this file only loads the original.
import { getOrderByNumberFresh } from "@/db/queries";
import { alertOps } from "@/actions/opsAlert";
import {
  originalOrderNumberFromTags,
  planReplacementPricing,
  type OriginalRow,
} from "@/lib/replacementOrigin";
import type { OrderData } from "@/types";

export type ReplacementPlan =
  | { kind: "ordinary" }
  | { kind: "replacement"; exchangeOf: string; priceByVariant: Record<string, string> }
  | { kind: "refused"; reason: string };

export async function planReplacementOrder(order: OrderData): Promise<ReplacementPlan> {
  const originalNumber = originalOrderNumberFromTags(order.tags);
  if (!originalNumber) return { kind: "ordinary" };

  const refuse = async (reason: string): Promise<ReplacementPlan> => {
    await alertOps(
      `[returns] REPLACEMENT ORDER NOT RETURNABLE ONLINE — ${order.name}`,
      `${order.name} is one of our exchange orders (original ${originalNumber}) and the portal could not value its lines.\n` +
        `Reason: ${reason}\n` +
        `The customer was told to contact us. Nothing was saved, so nothing was priced at list.`
    );
    return { kind: "refused", reason };
  };

  const original = await getOrderByNumberFresh(originalNumber);
  if (!original) return refuse(`original-not-found:${originalNumber}`);

  const lines = order.line_items
    .filter((item) => item.quantity > 0)
    .map((item) => ({ variant_id: item.variant_id, product_id: item.product_id }));
  const plan = planReplacementPricing(
    lines,
    ((original as any).products ?? []) as OriginalRow[]
  );
  if (!plan.ok) return refuse(plan.reason);

  return {
    kind: "replacement",
    exchangeOf: String(original.id),
    priceByVariant: plan.priceByVariant,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/replacementOrderLookup.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into the lookup**

In `db/repository.ts`, change `saveOrderDetails` to accept the link and write it:

```ts
export async function saveOrderDetails(
  order: OrderData,
  exchangeOf: string | null = null
): Promise<void> {
  await db.insert(orders).values({
    // ...existing fields unchanged...
    exchangeOf,
  });
}
```

In `actions/order.ts`, import `planReplacementOrder` and replace step 5 of `getOrder`:

```ts
  // 5. Save order to database. A replacement order is only saved once every
  // line can be valued from the original — see actions/replacementOrder.ts.
  const replacement = await planReplacementOrder(order);
  if (replacement.kind === "refused") {
    return {
      message:
        "Please contact hello@shamelesscollective.com with your order number to return items from this order",
    };
  }
  await saveOrderToDatabase(order, replacement);
```

and thread it through (`saveOrderToDatabase(order, replacement)` → `saveOrderDetails(order, replacement.kind === "replacement" ? replacement.exchangeOf : null)` → `insertOrderItems(orderItems, order.id, exchanges, returns, replacement)`), where `insertOrderItems` picks the price:

```ts
      // A replacement order's own prices are list prices; the customer paid
      // what the original's exchange row says. planReplacementOrder already
      // guaranteed every line has one, so there is no fallback here.
      const priceWithDiscount =
        replacement.kind === "replacement"
          ? Number(replacement.priceByVariant[String(item.variant_id)])
          : calculatePriceWithDiscount(item);
```

Type the new parameter as `ReplacementPlan` (exported from `actions/replacementOrder.ts`). The existing-order branch (step 4) is untouched: an order already in the DB is never re-planned (the repair script covers those).

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit -p . && npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add actions/replacementOrder.ts actions/order.ts db/repository.ts tests/replacementOrderLookup.test.ts
git commit -m "feat: value replacement-order lines from the original at lookup"
```

---

### Task 4: Store the root order's transaction at return creation

**Files:**
- Modify: `db/queries.ts` (add `getOrderTransactions`, near `getOrderTotal`)
- Modify: `actions/updateOrder.ts` (the `transaction_id` / `transaction_amount` write in `updateFinalOrder`, ~line 553)
- Test: `tests/replacementReturnTransaction.test.ts`

**Interfaces:**
- Consumes: `resolveRootOrderId` (Task 2); `pickRefundTransaction` (`lib/refundTransaction.ts`); `orders.exchangeOf` (Task 1).
- Produces: `getOrderTransactions(orderId: string): Promise<ShopifyTransaction[] | null>`; `refundSourceFor(dbOrder: { exchangeOf?: string | null } | null | undefined, fromReturn: { transactionId: string | null; transactionAmount: string | null }): Promise<{ transactionId: string | null; transactionAmount: string | null }>` exported from `actions/replacementOrder.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const LINKS: Record<string, string | null> = {};
const TX: Record<string, any[]> = {};
vi.mock("@/db/queries", () => ({
  getOrderByNumberFresh: async () => null,
  getOrderByIdFresh: async (id: string) => ({ id, exchangeOf: LINKS[id] ?? null }),
  getOrderTransactions: async (id: string) => TX[id] ?? null,
}));
vi.mock("@/actions/opsAlert", () => ({ alertOps: async () => {} }));

const PLACEHOLDER = { transactionId: "gid://shopify/OrderTransaction/0", transactionAmount: "0.01" };

beforeEach(() => {
  for (const k of Object.keys(LINKS)) delete LINKS[k];
  for (const k of Object.keys(TX)) delete TX[k];
});

async function source(dbOrder: any) {
  const { refundSourceFor } = await import("@/actions/replacementOrder");
  return refundSourceFor(dbOrder, PLACEHOLDER);
}

describe("refundSourceFor", () => {
  it("keeps the return's own transaction on an ordinary order", async () => {
    await expect(source({ id: "A", exchangeOf: null })).resolves.toEqual(PLACEHOLDER);
  });

  it("uses the root order's settled payment on a replacement order", async () => {
    LINKS["B"] = "A";
    TX["A"] = [{ id: "gid://shopify/OrderTransaction/9", kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "93.28" } } }];
    await expect(source({ id: "B", exchangeOf: "A" })).resolves.toEqual({
      transactionId: "gid://shopify/OrderTransaction/9",
      transactionAmount: "93.28",
    });
  });

  it("walks a chain to the root", async () => {
    LINKS["C"] = "B"; LINKS["B"] = "A";
    TX["A"] = [{ id: "root", kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "10" } } }];
    await expect(source({ id: "C", exchangeOf: "B" })).resolves.toMatchObject({ transactionId: "root" });
  });

  it("stores null rather than the placeholder when the root has no settled payment", async () => {
    LINKS["B"] = "A";
    TX["A"] = [];
    await expect(source({ id: "B", exchangeOf: "A" })).resolves.toEqual({
      transactionId: null,
      transactionAmount: null,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/replacementReturnTransaction.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `refundSourceFor` is not exported.

- [ ] **Step 3: Implement**

In `db/queries.ts`:

```ts
/**
 * The transactions of an order, for choosing what a refund is charged against.
 * Null on any failure — the caller stores null, which the refund lane refuses
 * with `no-refund-transaction` and the cron alerts on.
 */
export async function getOrderTransactions(orderId: string) {
  const session = createSession();
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const query = `
    query orderTransactions($id: ID!) {
      order(id: $id) {
        transactions { id kind status amountSet { shopMoney { amount } } }
      }
    }
  `;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables: { id: `gid://shopify/Order/${orderId}` } }),
    });
    const data = await response.json();
    return data?.data?.order?.transactions ?? null;
  } catch (error) {
    console.error("getOrderTransactions failed:", error);
    return null;
  }
}
```

In `actions/replacementOrder.ts` (add imports `getOrderByIdFresh`, `getOrderTransactions` from `@/db/queries`, `resolveRootOrderId` from `@/lib/replacementOrigin`, `pickRefundTransaction` from `@/lib/refundTransaction`):

```ts
/** Follow the stored links to the order holding the real payment. */
export async function rootOrderIdOf(orderId: string): Promise<string> {
  return resolveRootOrderId(orderId, async (id) => {
    const row = await getOrderByIdFresh(id);
    return (row as any)?.exchangeOf ?? null;
  });
}

/**
 * Which payment a return on this order is refunded against. A replacement
 * order's own transaction is the €0.01 placeholder, so it is never used.
 */
export async function refundSourceFor(
  dbOrder: { id?: string; exchangeOf?: string | null } | null | undefined,
  fromReturn: { transactionId: string | null; transactionAmount: string | null }
) {
  if (!dbOrder?.exchangeOf) return fromReturn;
  const rootId = await rootOrderIdOf(String(dbOrder.id));
  const tx = pickRefundTransaction(await getOrderTransactions(rootId));
  return {
    transactionId: tx?.id ?? null,
    transactionAmount: tx?.amountSet?.shopMoney?.amount ?? null,
  };
}
```

In `actions/updateOrder.ts`, just after `const result = await createReturn(returnInput);` has succeeded and before the `Promise.all` write:

```ts
  // On one of our replacement orders the return's own transaction is the €0.01
  // placeholder; the money is on the root order. See actions/replacementOrder.ts.
  const refundSource = await refundSourceFor(dbOrder, result.data);
```

and in the row update use `transaction_id: refundSource.transactionId, transaction_amount: refundSource.transactionAmount`.

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: all pass, including the existing `tests/createReturnTransaction.test.ts` (ordinary orders unchanged). If that file's `@/db/queries` mock lacks `getOrderTransactions`/`getOrderByIdFresh`, add them there, and mock `@/actions/replacementOrder` only if the file already mocks sibling actions.

- [ ] **Step 5: Commit**

```bash
git add db/queries.ts actions/replacementOrder.ts actions/updateOrder.ts tests/replacementReturnTransaction.test.ts
git commit -m "feat: refund replacement-order returns against the root payment"
```

---

### Task 5: `refundOnOrder` — idempotent money on the root order

**Files:**
- Modify: `db/queries.ts` (add `refundOnOrder` after `createRefund`)
- Test: `tests/refundOnOrder.test.ts`

**Interfaces:**
- Consumes: `refundTransactionAmount(amountEuros, moneySet)` from `lib/returnPayload.ts`.
- Produces: `refundOnOrder(orderId: string, transactionId: string, amountEuros: number, marker: string, note: string): Promise<{ success: true; alreadyRefunded: boolean } | { success: false; errors: unknown }>`

- [ ] **Step 1: Write the failing test** (mocks `fetch`; asserts request bodies)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const bodies: any[] = [];
let READ: any;
let WRITE: any;

beforeEach(() => {
  bodies.length = 0;
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.test";
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "t";
  READ = {
    data: { order: {
      refunds: [],
      totalPriceSet: {
        shopMoney: { amount: "93.28", currencyCode: "EUR" },
        presentmentMoney: { amount: "93.28", currencyCode: "EUR" },
      },
    } },
  };
  WRITE = { data: { refundCreate: { refund: { id: "r1" }, userErrors: [] } } };
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return { ok: true, json: async () => (body.query.includes("refundCreate") ? WRITE : READ) };
  });
});
afterEach(() => vi.unstubAllGlobals());

async function refund() {
  const { refundOnOrder } = await import("@/db/queries");
  return refundOnOrder("13282550841670", "gid://shopify/OrderTransaction/9", 42.03, "rli-MARK", "note");
}

describe("refundOnOrder", () => {
  it("refunds once, carrying the marker in the note", async () => {
    await expect(refund()).resolves.toEqual({ success: true, alreadyRefunded: false });
    const write = bodies.find((b) => b.query.includes("refundCreate"));
    expect(write.variables.input.transactions[0]).toMatchObject({
      parentId: "gid://shopify/OrderTransaction/9",
      amount: "42.03",
      kind: "REFUND",
    });
    expect(write.variables.input.note).toContain("rli-MARK");
  });

  it("does not refund again when a refund already carries the marker", async () => {
    READ.data.order.refunds = [{ note: "... rli-MARK ..." }];
    await expect(refund()).resolves.toEqual({ success: true, alreadyRefunded: true });
    expect(bodies.some((b) => b.query.includes("refundCreate"))).toBe(false);
  });

  it("refuses to move money when the order cannot be read", async () => {
    READ = { errors: [{ message: "boom" }] };
    const out = await refund();
    expect(out.success).toBe(false);
    expect(bodies.some((b) => b.query.includes("refundCreate"))).toBe(false);
  });

  it("converts to the root order's presentment currency", async () => {
    READ.data.order.totalPriceSet.presentmentMoney = { amount: "80.00", currencyCode: "GBP" };
    await refund();
    const write = bodies.find((b) => b.query.includes("refundCreate"));
    expect(write.variables.input.transactions[0].amount).toBe((42.03 * (80 / 93.28)).toFixed(2));
  });

  it("reports Shopify userErrors as a failure", async () => {
    WRITE = { data: { refundCreate: { refund: null, userErrors: [{ message: "no" }] } } };
    await expect(refund()).resolves.toMatchObject({ success: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/refundOnOrder.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `refundOnOrder` is not a function.

- [ ] **Step 3: Implement**

```ts
/**
 * Refund money on an order that is NOT the one the return lives on.
 *
 * Used for returns from our replacement orders, whose own payment is a €0.01
 * placeholder: the money goes back against the root order's real payment.
 * No line items — the goods are booked back on the replacement order by the
 * caller, and restocking here would count the garment twice.
 *
 * Idempotent on `marker` (the return line item id): a refund whose note already
 * contains it means the money moved on an earlier run, so nothing is sent.
 * An unreadable order refuses — it never refunds blind.
 */
export async function refundOnOrder(
  orderId: string,
  transactionId: string,
  amountEuros: number,
  marker: string,
  note: string
) {
  const session = createSession();
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const gid = `gid://shopify/Order/${orderId}`;
  const post = async (query: string, variables: Record<string, unknown>) =>
    (await fetch(url, { method: "POST", headers: session.headers, body: JSON.stringify({ query, variables }) })).json();

  try {
    const read = await post(
      `query rootRefunds($id: ID!) {
        order(id: $id) {
          refunds { note }
          totalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
        }
      }`,
      { id: gid }
    );
    const order = read?.data?.order;
    if (read.errors || !order) {
      console.error("refundOnOrder: cannot read order", orderId, read.errors);
      return { success: false as const, errors: read.errors ?? "order-not-found" };
    }
    if ((order.refunds ?? []).some((r: any) => String(r?.note ?? "").includes(marker))) {
      return { success: true as const, alreadyRefunded: true };
    }

    const set = order.totalPriceSet;
    const money = refundTransactionAmount(amountEuros, {
      shop_money: { amount: set?.shopMoney?.amount, currency_code: set?.shopMoney?.currencyCode },
      presentment_money: { amount: set?.presentmentMoney?.amount, currency_code: set?.presentmentMoney?.currencyCode },
    } as any);

    const written = await post(
      `mutation rootRefund($input: RefundInput!) {
        refundCreate(input: $input) {
          refund { id }
          userErrors { field message }
        }
      }`,
      {
        input: {
          orderId: gid,
          notify: true,
          note: `${note} [${marker}]`,
          transactions: [
            { orderId: gid, parentId: transactionId, amount: money.amount, gateway: "shopify_payments", kind: "REFUND" },
          ],
        },
      }
    );
    const errors = written.errors ?? written?.data?.refundCreate?.userErrors ?? [];
    if (errors.length > 0 || !written?.data?.refundCreate?.refund) {
      console.error("refundOnOrder failed:", errors);
      return { success: false as const, errors };
    }
    return { success: true as const, alreadyRefunded: false };
  } catch (error) {
    console.error("refundOnOrder fetch error:", error);
    return { success: false as const, errors: error };
  }
}
```

**Before implementing, verify one thing against Shopify docs** (shopify-plugin:shopify-admin skill): whether `RefundInput.transactions[].gateway` must match the parent transaction's gateway, and whether `amount` there is shop or presentment money in API 2025-01. The manual refund on #311749 (2026-09-27) used `gateway: "shopify_payments"` with an EUR order and was accepted. If the parent could be another gateway, read `gateway` from the order's transactions instead of hardcoding it — `getOrderTransactions` (Task 4) would need `gateway` added to its selection.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/refundOnOrder.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add db/queries.ts tests/refundOnOrder.test.ts
git commit -m "feat: idempotent refund on the root order of a replacement"
```

---

### Task 6: Settlement — two-order refund lane + top-up alert

**Files:**
- Modify: `lib/settleReturn.ts` (refund lane `else` branch; credit lane success path)
- Test: `tests/replacementSettlement.test.ts`

**Interfaces:**
- Consumes: `refundOnOrder` (Task 5); `createStoreCreditRefund`, `closeReturn`, `getOrderById` (existing); `rootOrderIdOf` (Task 4, `actions/replacementOrder.ts`); `wasProductSwap` (Task 2); `getOrderByIdFresh` (existing).
- Produces: `SettleOutcome` unchanged.

- [ ] **Step 1: Write the failing test** (same mock scaffold as `tests/settleRefundTransactionGuard.test.ts`, plus these)

```ts
// Scaffold: copy verbatim from tests/settleRefundTransactionGuard.test.ts the
// `react`, `next/cache`, `@/db/fees`, `@/lib/loadBasket`,
// `@/actions/exchangeReservation` and `@/actions/opsAlert` mocks (with its
// `alerts` array) and the `dbLine` holder. Replace its `@/db/drizzle` mock with
// this one, which records every `.set(...)` payload and its position:
const sets: any[] = [];
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (payload: any) => {
      sets.push(payload);
      if (payload?.refunded === true) sequence.push("mark");
      return chain;
    },
    where: () => Promise.resolve(),
    select: () => chain,
    from: () => Promise.resolve([]),
    query: { productsOrder: { findFirst: async () => dbLine.value, findMany: async () => [] } },
  };
  return { default: chain };
});

const rootRefunds: any[] = [];
const singleRefunds: any[] = [];
const bookings: string[] = [];
const sequence: string[] = []; // "mark" | "book" | "close", in call order
let ALLOW_SINGLE = false;
const closed: string[] = [];
let ROOT_REFUND: any = { success: true, alreadyRefunded: false };
let BOOKING: any = { success: true };
const ORDERS: Record<string, any> = {};

vi.mock("@/db/queries", () => ({
  getOrderById: async (id: string) => ORDERS[id],
  getOrderByIdFresh: async (id: string) => ORDERS[id],
  getOrderTotal: async () => ({ customer: { id: "c1" } }),
  processGiftCardReturn: async () => ({ success: true, data: { id: "gc1" } }),
  createRefund: async (...args: any[]) => {
    if (!ALLOW_SINGLE) throw new Error("must not refund on the replacement order");
    singleRefunds.push(args);
    return { success: true };
  },
  refundOnOrder: async (...args: any[]) => { rootRefunds.push(args); return ROOT_REFUND; },
  createStoreCreditRefund: async (returnId: string) => { sequence.push("book"); bookings.push(returnId); return BOOKING; },
  noteStoreCreditOnOrder: async () => ({ success: true }),
  createOrder: async () => ({ success: true }),
  closeReturn: async (id: string) => { sequence.push("close"); closed.push(id); return { success: true }; },
}));

beforeEach(() => {
  for (const a of [rootRefunds, singleRefunds, bookings, closed, sequence, sets, alerts]) a.length = 0;
  ROOT_REFUND = { success: true, alreadyRefunded: false };
  BOOKING = { success: true };
  ALLOW_SINGLE = false;
  ORDERS["A"] = { id: "A", orderNumber: "#311749", exchangeOf: null, stripePaymentIntent: null, returnMethod: "CORREOS",
    products: [{ variant_id: "old", productId: "P1", new_variant_id: "gid://shopify/ProductVariant/V", action: "CAMBIO", confirmed: true, price: "47.03" }] };
  ORDERS["B"] = { id: "B", orderNumber: "#312061", exchangeOf: "A", returnMethod: "CORREOS", shippingCountry: "Spain", shippingZip: "28001", products: [] };
  dbLine.value = { id: 1154, orderId: "B", variant_id: "V", productId: "P1", price: "47.03", credit: false,
    action: "DEVOLUCIÓN", refunded: false, return_id: "gid://shopify/Return/R", return_line_item_id: "gid://shopify/ReturnLineItem/L",
    transaction_id: "gid://shopify/OrderTransaction/9" };
});

const settle = async () => (await import("@/lib/settleReturn")).settleReturnLine(
  { variant_id: "V", return_id: "r", return_line_item_id: "rli" }, { id: "B" });

describe("refund lane on a replacement order", () => {
  it("moves the money on the ROOT order, price minus the return leg", async () => {
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(rootRefunds).toHaveLength(1);
    const [orderId, tx, amount, marker] = rootRefunds[0];
    expect(orderId).toBe("A");
    expect(tx).toBe("gid://shopify/OrderTransaction/9");
    expect(amount).toBeCloseTo(42.03, 2);
    expect(marker).toBe("gid://shopify/ReturnLineItem/L");
  });

  it("marks the row refunded BEFORE booking the goods", async () => {
    await settle();
    expect(sequence).toEqual(["mark", "book", "close"]);
    expect(bookings).toEqual(["gid://shopify/Return/R"]);
  });

  it("stays settled and alerts when booking the goods fails", async () => {
    BOOKING = { success: false, errors: ["x"] };
    const out = await settle();
    expect(out.settled).toBe(true);
    expect(sets.some((s) => s.refunded === true)).toBe(true);
    expect(alerts.some((a) => a.subject.includes("#312061"))).toBe(true);
  });

  it("marks nothing when the root refund fails", async () => {
    ROOT_REFUND = { success: false, errors: ["no"] };
    const out = await settle();
    expect(out).toEqual({ settled: false, reason: "refund-failed" });
    expect(sets).toHaveLength(0);
    expect(bookings).toHaveLength(0);
  });

  it("a replay after the money moved pays nothing (marker path)", async () => {
    ROOT_REFUND = { success: true, alreadyRefunded: true };
    const out = await settle();
    expect(out.settled).toBe(true);
    expect(sets.some((s) => s.refunded === true)).toBe(true);
  });

  it("alerts about a possible top-up on a product swap with a Stripe payment", async () => {
    ORDERS["A"].stripePaymentIntent = "pi_123";
    dbLine.value!.productId = "P2"; // replacement is a different product
    await settle();
    expect(alerts.some((a) => a.body.includes("pi_123"))).toBe(true);
  });

  it("does not alert a top-up on a size swap", async () => {
    ORDERS["A"].stripePaymentIntent = "pi_123";
    await settle();
    expect(alerts.some((a) => a.body.includes("pi_123"))).toBe(false);
  });

  it("leaves ordinary orders on the existing single-order path", async () => {
    ORDERS["B"].exchangeOf = null;
    ALLOW_SINGLE = true;
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(rootRefunds).toHaveLength(0);
    expect(singleRefunds).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/replacementSettlement.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `createRefund` mock throws "must not refund on the replacement order".

- [ ] **Step 3: Implement in `lib/settleReturn.ts`**

Add imports: `refundOnOrder`, `getOrderByIdFresh` from `@/db/queries`; `rootOrderIdOf` from `@/actions/replacementOrder`; `wasProductSwap` from `@/lib/replacementOrigin`.

Add a helper above `settleReturnLine`:

```ts
/**
 * Tell ops when a returned replacement may have cost the customer more than
 * the original line price we pay back: a swap to a DIFFERENT product can carry
 * a Stripe top-up, and that money is on Stripe, not on the Shopify order.
 * Informational only — never blocks settlement.
 */
async function alertPossibleTopUp(line: any, order: any, lane: string) {
  if (!order?.exchangeOf) return;
  const original = await getOrderByIdFresh(String(order.exchangeOf));
  const pi = (original as any)?.stripePaymentIntent;
  if (!pi) return;
  if (!wasProductSwap((original as any)?.products ?? [], String(line.variant_id), String(line.productId))) return;
  await alertOps(
    `[returns] POSSIBLE TOP-UP OWED — ${order.orderNumber}`,
    `${order.orderNumber} is a replacement for ${original?.orderNumber}. The customer swapped to a different product and paid through Stripe (${pi}).\n` +
      `The ${lane} paid only the original line price (${line.price} EUR). Check whether part of ${pi} was a top-up for this garment and refund it from Stripe if so.`
  );
}
```

In the refund lane, after the `no-refund-transaction` guard and inside `if (product.return_id && product.return_line_item_id)`, load `settlementOrder` as today, compute `amountToRefund` as today, then branch:

```ts
      if (settlementOrder?.exchangeOf) {
        // A replacement order's payment is a €0.01 placeholder: the money goes
        // back on the ROOT order, the goods come back on this one. Order
        // matters — see the numbered steps.
        const rootId = await rootOrderIdOf(String(settlementOrder.id));
        const marker = String(trustedLine.return_line_item_id ?? "");
        // 1+2. Money, idempotent on the return line item id.
        const money = await refundOnOrder(
          rootId,
          refundTransactionId,
          amountToRefund,
          marker,
          `Return from replacement order ${settlementOrder.orderNumber}`
        );
        if (!money.success) return { settled: false, reason: "refund-failed" };
        // 3. Paid — record it before anything else can fail, so no later run
        // can pay again.
        await db.update(productsOrder).set({ refunded: true }).where(eq(productsOrder.id, trustedLine.id));
        // 4. Goods. Accounting only; a failure here is cleanup, not a debt.
        const booked = await createStoreCreditRefund(
          String(trustedLine.return_id ?? ""),
          marker
        );
        const closedReturn = booked.success
          ? await closeReturn(String(trustedLine.return_id ?? ""))
          : booked;
        if (!booked.success || !closedReturn.success) {
          await alertOps(
            `[returns] REPLACEMENT RETURN PAID, NOT BOOKED — ${settlementOrder.orderNumber}`,
            `The customer WAS refunded ${amountToRefund.toFixed(2)} EUR on the root order. Booking the goods back on ${settlementOrder.orderNumber} (${trustedLine.return_id}) failed — record the return and close it by hand. Do NOT refund again.`
          );
        }
        await alertPossibleTopUp(trustedLine, settlementOrder, "refund");
        return { settled: true, lane: "refund", lineIds: [String(trustedLine.id)] };
      }
```

The existing `createRefund` path below stays as the ordinary-order path.

In the credit lane, right before its `return { settled: true, lane: "credit", ... }`, add:

```ts
      await alertPossibleTopUp(trustedLine, dbOrder, "store credit");
```

(`dbOrder` is the `getOrderById` result already loaded in that lane.)

- [ ] **Step 4: Run test + full suite**

Run: `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`
Expected: all pass, including `settleRefundTransactionGuard`, `creditLaneSettlement`, `settleReturnLineScoping` (add `refundOnOrder` / `getOrderByIdFresh` to their `@/db/queries` mocks and a `@/actions/replacementOrder` mock if they fail on import).

- [ ] **Step 5: Revert proof**

Temporarily delete the `if (settlementOrder?.exchangeOf) { ... }` block; run `tests/replacementSettlement.test.ts`; confirm the root-refund, ordering and replay tests FAIL. Temporarily move the `db.update(...refunded: true)` line below the booking; confirm the "stays settled when booking fails" and ordering tests FAIL. Restore both. Record the failing output in the task report.

- [ ] **Step 6: Commit**

```bash
git add lib/settleReturn.ts tests/replacementSettlement.test.ts tests/*.test.ts
git commit -m "feat: settle replacement-order refunds on the root order"
```

---

### Task 7: One-off repair of existing rows

**Files:**
- Create: `scripts/repair-replacement-order-rows.ts`

**Interfaces:**
- Consumes: `originalOrderNumberFromTags`, `planReplacementPricing` (Task 2); `getOrderQuery`, `getOrderByNumberFresh`, `getOrderTransactions` (existing / Task 4); `pickRefundTransaction`; `resolveRootOrderId`.

- [ ] **Step 1: Write the script**

```ts
// One-off: link replacement orders already in the DB to their original, and
// correct the price + refund transaction on their confirmed, UNSETTLED rows.
// Dry run unless `--write`. Settled rows are reported, never touched.
//
//   npx tsx scripts/repair-replacement-order-rows.ts          # dry
//   npx tsx scripts/repair-replacement-order-rows.ts --write  # apply
import "dotenv/config";
import React from "react";
const R = React as any;
if (typeof R.cache !== "function") R.cache = (fn: any) => fn;

async function main() {
  const write = process.argv.includes("--write");
  const { default: db } = await import("@/db/drizzle");
  const { orders, productsOrder } = await import("@/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const q = await import("@/db/queries");
  const { originalOrderNumberFromTags, planReplacementPricing, resolveRootOrderId } =
    await import("@/lib/replacementOrigin");
  const { pickRefundTransaction } = await import("@/lib/refundTransaction");

  // Candidates: orders whose stored refund transaction is the placeholder.
  const candidates = await db.execute(sql`
    select distinct o.id, o.order_number from orders o
    join productsorder p on p.order_id = o.id
    where p.transaction_amount = '0.01' and o.exchange_of is null`);

  for (const c of candidates.rows as any[]) {
    const shopify = await q.getOrderQuery(String(c.order_number).replace("#", ""));
    const originalNumber = originalOrderNumberFromTags(shopify?.tags);
    if (!originalNumber) { console.log(`${c.order_number}: not tagged as a replacement — SKIP`); continue; }
    const original = await q.getOrderByNumberFresh(originalNumber);
    if (!original) { console.log(`${c.order_number}: original ${originalNumber} not in DB — SKIP`); continue; }

    const rows = await db.query.productsOrder.findMany({ where: eq(productsOrder.orderId, String(c.id)) });
    const open = rows.filter((r: any) => r.confirmed && !r.refunded);
    const settled = rows.filter((r: any) => r.confirmed && r.refunded);
    settled.forEach((r: any) => console.log(`${c.order_number}: row ${r.id} ALREADY SETTLED at ${r.price} (report only)`));

    const plan = planReplacementPricing(
      open.map((r: any) => ({ variant_id: r.variant_id, product_id: r.productId })),
      ((original as any).products ?? []) as any
    );
    const rootId = await resolveRootOrderId(String(original.id), async (id) =>
      ((await q.getOrderByIdFresh(id)) as any)?.exchangeOf ?? null);
    const tx = pickRefundTransaction(await q.getOrderTransactions(rootId));

    console.log(`${c.order_number} → original ${originalNumber} (root ${rootId}), tx ${tx?.id} ${tx?.amountSet?.shopMoney?.amount}`);
    if (open.length && !plan.ok) { console.log(`  CANNOT PRICE: ${plan.reason} — SKIP`); continue; }
    for (const r of open as any[]) {
      console.log(`  row ${r.id} ${r.title}: price ${r.price} → ${plan.ok ? plan.priceByVariant[String(r.variant_id)] : "-"}`);
    }

    if (!write) continue;
    await db.update(orders).set({ exchangeOf: String(original.id) }).where(eq(orders.id, String(c.id)));
    if (plan.ok) {
      for (const r of open as any[]) {
        await db.update(productsOrder).set({
          price: plan.priceByVariant[String(r.variant_id)],
          transaction_id: tx?.id ?? null,
          transaction_amount: tx?.amountSet?.shopMoney?.amount ?? null,
        }).where(eq(productsOrder.id, r.id));
      }
    }
    console.log(`  WRITTEN`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Commit** (the script is not run here — it runs in rollout, after the migration)

```bash
git add scripts/repair-replacement-order-rows.ts
git commit -m "chore: script to repair replacement-order rows already in the DB"
```

---

### Task 8: Rollout (operator steps, with the user)

- [ ] **Step 1:** Apply `drizzle/0003_exchange_of.sql` on `ShamelessReturns` (`psql "$DATABASE_URL" -f drizzle/0003_exchange_of.sql`) after confirming `select current_database()` = `ShamelessReturns`.
- [ ] **Step 2:** Verify: `select column_name from information_schema.columns where table_name='orders' and column_name='exchange_of';` → 1 row.
- [ ] **Step 3:** Whole-branch review (money path — per the repo's standing rule), then PR, merge, deploy by pushing `main`.
- [ ] **Step 4:** Run the repair script DRY; expect #312060, #37841, #37863, #37930 (plus the already-settled rows reported only). Review the output with the user.
- [ ] **Step 5:** Run with `--write`; re-read the four rows with `psql` to confirm price, `transaction_id` and `exchange_of`.
- [ ] **Step 6:** After the next 07:00 UTC auto-approve run, check `vercel logs --query "auto-approve"` for #312060: settled, or held for a reason other than `refund-failed`.
- [ ] **Step 7:** Confirm #311749's manual €42.03 refund reached `SUCCESS`.
