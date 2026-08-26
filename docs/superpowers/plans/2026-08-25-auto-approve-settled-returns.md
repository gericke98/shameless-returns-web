# Auto-Approving Settled Returns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily cron that settles returns whose garments Amphora has counted into the warehouse and whose Shopify return is still `OPEN`, running the same payout the dashboard button runs.

**Architecture:** A pure decision function (`lib/autoApproveGate.ts`) decides eligibility per order from three inputs — the Amphora return record, the Shopify return status, and our own lines. The payout itself is lifted out of the admin-only server action into `lib/settleReturn.ts` so the button and the cron share one implementation. The route (`app/api/cron/auto-approve/route.ts`) is glue: authorise, gather, decide, settle under a cap.

**Tech Stack:** Next.js App Router (route handlers), Drizzle + Neon, Shopify Admin GraphQL 2025-01, Amphora Company API, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-auto-approve-settled-returns-design.md`

## Global Constraints

- **Fail closed, always.** Unset `CRON_SECRET` → 401. Unreadable Shopify status → ineligible, never assumed `OPEN`. Unknown Amphora status → ineligible.
- **Warehouse status allowlist is exactly:** `RECEIVED`, `PROCESSING_WAREHOUSE`, `FINISHED`. Never a blocklist.
- **Amphora sends `quantity` and `quantity_received` as STRINGS** (`"0"`, `"1"`). `"0"` is truthy. Every comparison coerces with `Number()`.
- **Amphora timestamps come both bare (`2026-08-17T12:56:05`) and offset-aware (`2026-08-10T00:14:42+00:00`).** A bare stamp is read as UTC, matching `lib/amphoraReturnMatch.ts::createdAt`.
- **A short receipt holds the WHOLE order**, every line, including exchange siblings.
- **No new money rules.** The €5 deduction and the ×1.15 credit multiplier are moved, never re-typed. This job decides *when* to settle, never *how much*.
- Defaults: `AUTO_APPROVE_GRACE_DAYS=2`, `AUTO_APPROVE_MAX_PER_RUN=25`. Unset `AUTO_APPROVE_ENABLED` means dry-run.
- Baseline before starting: `npm test` → **75 files, 727 tests, all passing.**

---

### Task 1: The eligibility gate

Pure. No db, no network, no env, no clock of its own. Everything else in this plan is plumbing around this function, so it is written and tested first.

**Files:**
- Create: `lib/autoApproveGate.ts`
- Test: `tests/autoApproveGate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `decideAutoApprove(input: GateInput): GateVerdict`, plus exported types `GateLine`, `GateAmphoraReturn`, `GateInput`, `GateVerdict`.

```ts
export type GateLine = {
  id: string;
  variant_id: string;
  quantity: number;
  return_id: string | null;
  refunded: boolean | null;
  confirmed: boolean | null;
  sku: string | null;
};
export type GateAmphoraReturn = {
  internal_status: string;
  time_received?: string | null;
  items?: Array<{ sku: string | null; quantity: number | string; quantity_received: number | string }>;
};
export type GateInput = {
  lines: GateLine[];
  amphora: GateAmphoraReturn | null;
  shopifyReturnStatus: Record<string, string | undefined>;
  now: Date;
  graceDays: number;
};
export type GateVerdict =
  | { settle: true; lines: GateLine[] }
  | { settle: false; reason: string };
```

- [ ] **Step 1: Write the failing test**

Create `tests/autoApproveGate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideAutoApprove, type GateInput } from "@/lib/autoApproveGate";

const NOW = new Date("2026-08-25T12:00:00Z");

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    lines: [
      { id: "l1", variant_id: "v1", quantity: 1, return_id: "gid://shopify/Return/1",
        refunded: false, confirmed: true, sku: "20250503" },
    ],
    amphora: {
      internal_status: "RECEIVED",
      time_received: "2026-08-17T12:56:05",
      items: [{ sku: "20250503", quantity: "1", quantity_received: "1" }],
    },
    shopifyReturnStatus: { "gid://shopify/Return/1": "OPEN" },
    now: NOW,
    graceDays: 2,
    ...over,
  };
}

describe("decideAutoApprove — the happy path", () => {
  it("settles a received, unpaid, out-of-grace return", () => {
    const verdict = decideAutoApprove(input());
    expect(verdict).toEqual({ settle: true, lines: [expect.objectContaining({ id: "l1" })] });
  });

  it("accepts every warehouse status in the allowlist", () => {
    for (const s of ["RECEIVED", "PROCESSING_WAREHOUSE", "FINISHED"]) {
      const v = decideAutoApprove(input({ amphora: { ...input().amphora!, internal_status: s } }));
      expect(v.settle, s).toBe(true);
    }
  });
});

describe("decideAutoApprove — Amphora status is an allowlist", () => {
  it("refuses a status we have never seen, rather than assuming it is fine", () => {
    // No EXCEPTION* return exists in live data, so an unknown string is the
    // realistic case — it must not pay anyone out.
    const v = decideAutoApprove(input({ amphora: { ...input().amphora!, internal_status: "SOMETHING_NEW" } }));
    expect(v).toEqual({ settle: false, reason: "status-not-in-warehouse:SOMETHING_NEW" });
  });

  it("refuses a return still travelling", () => {
    const v = decideAutoApprove(input({ amphora: { ...input().amphora!, internal_status: "TRAVELLING" } }));
    expect(v.settle).toBe(false);
  });

  it("refuses when there is no Amphora record at all", () => {
    expect(decideAutoApprove(input({ amphora: null }))).toEqual({
      settle: false, reason: "no-amphora-record",
    });
  });
});

describe("decideAutoApprove — quantity_received is a string", () => {
  it('does not settle on quantity_received "0" — the string is truthy', () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, items: [{ sku: "20250503", quantity: "1", quantity_received: "0" }] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250503" });
  });

  it('treats "1" and 1 as the same count', () => {
    const asString = decideAutoApprove(input());
    const asNumber = decideAutoApprove(input({
      amphora: { ...input().amphora!, items: [{ sku: "20250503", quantity: 1, quantity_received: 1 }] },
    }));
    expect(asNumber).toEqual(asString);
  });

  it("refuses when the SKU is absent from the Amphora items entirely", () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, items: [{ sku: "OTHER", quantity: "1", quantity_received: "1" }] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250503" });
  });

  it("refuses when we could not resolve our own line to a SKU", () => {
    const v = decideAutoApprove(input({
      lines: [{ ...input().lines[0], sku: null }],
    }));
    expect(v).toEqual({ settle: false, reason: "unresolved-sku:v1" });
  });

  it("does not let two lines of the same SKU both claim one received garment", () => {
    // The customer declared two of the same garment; one came back.
    const v = decideAutoApprove(input({
      lines: [
        { ...input().lines[0], id: "l1" },
        { ...input().lines[0], id: "l2" },
      ],
      amphora: { ...input().amphora!, items: [{ sku: "20250503", quantity: "2", quantity_received: "1" }] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250503" });
  });
});

describe("decideAutoApprove — one short line holds the whole order", () => {
  it("settles nothing when a sibling line is short", () => {
    const v = decideAutoApprove(input({
      lines: [
        { id: "l1", variant_id: "v1", quantity: 1, return_id: "gid://shopify/Return/1",
          refunded: false, confirmed: true, sku: "20250503" },
        { id: "l2", variant_id: "v2", quantity: 1, return_id: "gid://shopify/Return/1",
          refunded: false, confirmed: true, sku: "20250504" },
      ],
      amphora: { ...input().amphora!, items: [
        { sku: "20250503", quantity: "1", quantity_received: "1" },
        { sku: "20250504", quantity: "1", quantity_received: "0" },
      ] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250504" });
  });
});

describe("decideAutoApprove — Shopify says whether we already paid", () => {
  it("refuses a CLOSED return — 52 of 168 lines were in this state", () => {
    const v = decideAutoApprove(input({
      shopifyReturnStatus: { "gid://shopify/Return/1": "CLOSED" },
    }));
    expect(v).toEqual({ settle: false, reason: "shopify-not-open:CLOSED" });
  });

  it("refuses a CANCELED return", () => {
    const v = decideAutoApprove(input({
      shopifyReturnStatus: { "gid://shopify/Return/1": "CANCELED" },
    }));
    expect(v).toEqual({ settle: false, reason: "shopify-not-open:CANCELED" });
  });

  it("refuses when the status could not be read — absence is never OPEN", () => {
    const v = decideAutoApprove(input({ shopifyReturnStatus: {} }));
    expect(v).toEqual({ settle: false, reason: "shopify-unreadable:gid://shopify/Return/1" });
  });

  it("refuses a line carrying no return id", () => {
    const v = decideAutoApprove(input({ lines: [{ ...input().lines[0], return_id: null }] }));
    expect(v).toEqual({ settle: false, reason: "no-return-id:l1" });
  });
});

describe("decideAutoApprove — the grace period", () => {
  it("refuses a return received an hour ago", () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: "2026-08-25T11:00:00" },
    }));
    expect(v).toEqual({ settle: false, reason: "within-grace" });
  });

  it("reads a bare stamp as UTC, not as the runner's local time", () => {
    // Bare and offset-aware forms of the same instant must decide identically,
    // or the job behaves differently on a laptop than on Vercel.
    const bare = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: "2026-08-23T11:59:00" },
    }));
    const offset = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: "2026-08-23T11:59:00+00:00" },
    }));
    expect(bare).toEqual(offset);
  });

  it("refuses when there is no receipt timestamp to measure from", () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: null },
    }));
    expect(v).toEqual({ settle: false, reason: "no-receipt-timestamp" });
  });
});

describe("decideAutoApprove — nothing to do", () => {
  it("reports nothing-to-settle when every line is already refunded", () => {
    const v = decideAutoApprove(input({ lines: [{ ...input().lines[0], refunded: true }] }));
    expect(v).toEqual({ settle: false, reason: "nothing-to-settle" });
  });

  it("ignores unconfirmed lines entirely", () => {
    const v = decideAutoApprove(input({ lines: [{ ...input().lines[0], confirmed: false }] }));
    expect(v).toEqual({ settle: false, reason: "nothing-to-settle" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autoApproveGate.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/autoApproveGate"`.

- [ ] **Step 3: Write the implementation**

Create `lib/autoApproveGate.ts`:

```ts
/**
 * May this order be settled without a human looking at it?
 *
 * Pure — no db, no network, no env, no clock. Every input is passed in so the
 * whole decision is unit-testable, because this function is the only thing
 * standing between an automated cron and someone's money.
 *
 * It answers TWO independent questions, and needs both:
 *   · did the goods come back?      — Amphora's `quantity_received`
 *   · have we already paid?          — the Shopify return status
 * Amphora knows nothing about the second. A gate built only on Amphora would
 * have re-refunded ~49 customers on its first run (see the design doc).
 */

/** The only statuses that mean "the warehouse has our garments".
 *
 *  An ALLOWLIST on purpose. Across 143 live returns not one EXCEPTION* or
 *  FINISHED_REJECTED exists, so we have never seen what a rejected return looks
 *  like on the wire. A blocklist would pay out on any status we failed to
 *  predict; this refuses everything it does not recognise. */
const WAREHOUSE_STATUSES = new Set(["RECEIVED", "PROCESSING_WAREHOUSE", "FINISHED"]);

const MS_PER_DAY = 86_400_000;

export type GateLine = {
  id: string;
  variant_id: string;
  quantity: number;
  return_id: string | null;
  refunded: boolean | null;
  confirmed: boolean | null;
  /** Resolved from Shopify; null when we could not, which is never eligible. */
  sku: string | null;
};

export type GateAmphoraReturn = {
  internal_status: string;
  time_received?: string | null;
  items?: Array<{
    sku: string | null;
    quantity: number | string;
    quantity_received: number | string;
  }>;
};

export type GateInput = {
  lines: GateLine[];
  amphora: GateAmphoraReturn | null;
  /** Shopify `Return.status` by return gid. A gid ABSENT from this map could
   *  not be read, and must never be treated as OPEN. */
  shopifyReturnStatus: Record<string, string | undefined>;
  now: Date;
  graceDays: number;
};

export type GateVerdict =
  | { settle: true; lines: GateLine[] }
  | { settle: false; reason: string };

/** Amphora sends counts as strings — `"0"` is truthy, so never test one for
 *  truthiness. NaN for anything unparseable, which fails every comparison
 *  below and so refuses to settle. */
function count(value: unknown): number {
  return Number(String(value ?? "").trim());
}

/** Amphora sends both bare local stamps and offset-aware ones. Read a bare one
 *  as UTC so this decides the same on a laptop and in a Vercel function —
 *  the same rule as `lib/amphoraReturnMatch.ts::createdAt`. */
function parseStamp(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const iso = /[Z+]|-\d{2}:\d{2}$/.test(stamp) ? stamp : `${stamp}Z`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function decideAutoApprove(input: GateInput): GateVerdict {
  const pending = input.lines.filter((l) => l.confirmed === true && !l.refunded);
  if (pending.length === 0) return { settle: false, reason: "nothing-to-settle" };

  const ret = input.amphora;
  if (!ret) return { settle: false, reason: "no-amphora-record" };

  const status = String(ret.internal_status ?? "").trim().toUpperCase();
  if (!WAREHOUSE_STATUSES.has(status)) {
    return { settle: false, reason: `status-not-in-warehouse:${status || "(empty)"}` };
  }

  const receivedAt = parseStamp(ret.time_received);
  if (receivedAt == null) return { settle: false, reason: "no-receipt-timestamp" };
  if (input.now.getTime() - receivedAt < input.graceDays * MS_PER_DAY) {
    return { settle: false, reason: "within-grace" };
  }

  // Did the warehouse actually count our garments in? Drawn from a POOL rather
  // than compared per line, so two lines of the same SKU cannot both claim one
  // received garment.
  const pool = new Map<string, number>();
  for (const item of ret.items ?? []) {
    const sku = String(item.sku ?? "").trim();
    if (!sku) continue;
    pool.set(sku, (pool.get(sku) ?? 0) + count(item.quantity_received));
  }
  for (const line of pending) {
    const sku = String(line.sku ?? "").trim();
    if (!sku) return { settle: false, reason: `unresolved-sku:${line.variant_id}` };
    const available = pool.get(sku) ?? 0;
    // NaN fails this comparison, which is the intent.
    if (!(available >= line.quantity)) {
      return { settle: false, reason: `short-receipt:${sku}` };
    }
    pool.set(sku, available - line.quantity);
  }

  // Have we already paid? `refunded` above is OUR record of that, and it drifts:
  // anything settled in the Shopify admin never comes back through the button.
  for (const line of pending) {
    if (!line.return_id) return { settle: false, reason: `no-return-id:${line.id}` };
    const shopify = input.shopifyReturnStatus[line.return_id];
    if (shopify === undefined) {
      return { settle: false, reason: `shopify-unreadable:${line.return_id}` };
    }
    if (shopify !== "OPEN") {
      return { settle: false, reason: `shopify-not-open:${shopify}` };
    }
  }

  return { settle: true, lines: pending };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autoApproveGate.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/autoApproveGate.ts tests/autoApproveGate.test.ts
git commit -m "feat: pure gate deciding whether a return may settle unattended"
```

---

### Task 2: Read Shopify return statuses in bulk

**Files:**
- Modify: `db/queries.ts` (append a new exported function; follow `getVariantSkusByIds` at `db/queries.ts:1087` for the fetch/error shape)
- Test: `tests/returnStatusRead.test.ts`

**Interfaces:**
- Consumes: `createSession()` (module-private, already in `db/queries.ts`).
- Produces: `getReturnStatusesByIds(returnIds: string[]): Promise<Record<string, string>>` — maps return gid → `"OPEN" | "CLOSED" | "CANCELED" | "DECLINED" | "REQUESTED"`. **A return that cannot be read is simply absent from the map.**

- [ ] **Step 1: Write the failing test**

Create `tests/returnStatusRead.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

// The auto-approve gate treats a status it cannot read as ineligible. That is
// only safe if this reader never invents one — a return Shopify does not return
// must be ABSENT from the map, not defaulted.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const calls: any[] = [];
function mockFetch(payloads: any[]) {
  let i = 0;
  return vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const payload = payloads[Math.min(i++, payloads.length - 1)];
    return { ok: true, json: async () => payload } as any;
  });
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

async function subject() {
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.test";
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  return (await import("@/db/queries")).getReturnStatusesByIds;
}

describe("getReturnStatusesByIds", () => {
  it("maps each return gid to its status", async () => {
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [
      { id: "gid://shopify/Return/1", status: "OPEN" },
      { id: "gid://shopify/Return/2", status: "CLOSED" },
    ] } }]));

    const get = await subject();
    expect(await get(["gid://shopify/Return/1", "gid://shopify/Return/2"])).toEqual({
      "gid://shopify/Return/1": "OPEN",
      "gid://shopify/Return/2": "CLOSED",
    });
  });

  it("omits a return Shopify did not return, rather than defaulting it", async () => {
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [null] } }]));

    const get = await subject();
    expect(await get(["gid://shopify/Return/404"])).toEqual({});
  });

  it("makes no network call for an empty list", async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal("fetch", fetchMock);

    const get = await subject();
    expect(await get([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("de-duplicates ids before asking", async () => {
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [{ id: "gid://shopify/Return/1", status: "OPEN" }] } }]));

    const get = await subject();
    await get(["gid://shopify/Return/1", "gid://shopify/Return/1"]);
    expect(calls[0].variables.ids).toEqual(["gid://shopify/Return/1"]);
  });

  it("batches beyond 40 ids into separate requests", async () => {
    const ids = Array.from({ length: 41 }, (_, i) => `gid://shopify/Return/${i}`);
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [] } }]));

    const get = await subject();
    await get(ids);
    expect(calls).toHaveLength(2);
    expect(calls[0].variables.ids).toHaveLength(40);
    expect(calls[1].variables.ids).toHaveLength(1);
  });

  it("throws rather than returning a partial map when Shopify errors", async () => {
    // A partial map reads to the gate as "unreadable", which is safe — but a
    // silent partial across a 25-line run hides a broken integration. Loud.
    vi.stubGlobal("fetch", mockFetch([{ errors: [{ message: "Throttled" }] }]));

    const get = await subject();
    await expect(get(["gid://shopify/Return/1"])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/returnStatusRead.test.ts`
Expected: FAIL — `getReturnStatusesByIds is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `db/queries.ts`:

```ts
/**
 * Shopify's own view of whether a return is finished.
 *
 * `productsorder.refunded` is written in exactly ONE place — the dashboard
 * button — so any return settled in the Shopify admin instead leaves our flag
 * false forever. Measured 2026-08-25: 52 of 168 unsettled lines were already
 * CLOSED or CANCELED in Shopify. Anything settling automatically must ask
 * Shopify, or it pays those customers twice.
 *
 * A return that cannot be read is ABSENT from the result, never defaulted —
 * `decideAutoApprove` treats absence as ineligible.
 */
export async function getReturnStatusesByIds(
  returnIds: string[]
): Promise<Record<string, string>> {
  const ids = Array.from(new Set(returnIds.filter(Boolean)));
  if (ids.length === 0) return {};

  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const query = `
    query getReturnStatuses($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Return { id status }
      }
    }
  `;

  const statuses: Record<string, string> = {};
  // `nodes` is capped by Shopify's cost limits; 40 keeps us well inside it.
  for (let i = 0; i < ids.length; i += 40) {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: (session as any).headers,
      body: JSON.stringify({ query, variables: { ids: ids.slice(i, i + 40) } }),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const { data, errors } = await response.json();
    if (errors) {
      console.error("GraphQL Errors:", errors);
      throw new Error("GraphQL query failed");
    }
    for (const node of data?.nodes ?? []) {
      if (node?.id && node?.status) statuses[node.id] = node.status;
    }
  }
  return statuses;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/returnStatusRead.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add db/queries.ts tests/returnStatusRead.test.ts
git commit -m "feat: bulk-read Shopify return statuses, absent when unreadable"
```

---

### Task 3: Load the orders with unsettled returns

**Files:**
- Modify: `db/queries.ts` (append; sits beside `getSelfReturnsAwaitingTracking`)

**Interfaces:**
- Produces: `getOrdersWithUnsettledReturns()` — every order carrying at least one confirmed, unrefunded line, with `products` narrowed to confirmed lines only.

No test of its own: it is a two-line Drizzle query with no branching, and Task 5's route test exercises it through a mock. Adding a test here would test Drizzle, not us.

- [ ] **Step 1: Write the implementation**

Append to `db/queries.ts`:

```ts
/**
 * Orders with at least one confirmed line still awaiting settlement.
 *
 * Deliberately NOT cached, for the same reason as `getOrderByIdFresh`: the
 * auto-approve cron acts on what it reads and settles in a loop, so a cached
 * read would let it decide twice from one snapshot.
 */
export async function getOrdersWithUnsettledReturns() {
  const rows = await db.query.orders.findMany({
    with: { products: { where: eq(productsOrder.confirmed, true) } },
  });
  return rows.filter((order) => order.products.some((p) => !p.refunded));
}
```

- [ ] **Step 2: Verify it type-checks and nothing regressed**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; 727 tests still passing.

- [ ] **Step 3: Commit**

```bash
git add db/queries.ts
git commit -m "feat: query orders with confirmed lines still awaiting settlement"
```

---

### Task 4: Extract the settlement core

The riskiest task in this plan — it moves live money code. It adds no behaviour: the existing suite is the safety net, and every one of `tests/adminActions.test.ts`, `tests/exchangeOrderBatching.test.ts`, `tests/selfBookedSettlement.test.ts` and `tests/orderNoteStoreCredit.test.ts` must stay green **without being edited**. If a test needs changing, the extraction changed behaviour — stop and reassess.

**Files:**
- Create: `lib/settleReturn.ts`
- Modify: `actions/refund.ts` (becomes a thin authorised wrapper)

**Interfaces:**
- Consumes: everything `actions/refund.ts` imports today — moved wholesale.
- Produces: `settleReturnLine(product: any, order: any): Promise<SettleOutcome>` where
  ```ts
  export type SettleOutcome =
    | { settled: true; lane: "credit" | "exchange" | "refund" }
    | { settled: false; reason: string };
  ```

- [ ] **Step 1: Confirm the safety net is green before touching anything**

Run: `npx vitest run tests/adminActions.test.ts tests/exchangeOrderBatching.test.ts tests/selfBookedSettlement.test.ts tests/orderNoteStoreCredit.test.ts`
Expected: PASS. Record the test count — it must be identical at Step 4.

- [ ] **Step 2: Move the body into `lib/settleReturn.ts`**

Create `lib/settleReturn.ts`. Move the **entire body** of `validateReturn` from `actions/refund.ts` — the `isSelfBooked` helper, all three lanes, the `alertOps` call, the `trustedLine` re-read, every comment — with exactly four changes:

1. Drop the `"use server"` directives and the `isAdmin()` block (the caller owns authorisation).
2. Drop every `revalidatePath("/", "layout")` call (the caller owns cache invalidation).
3. Drop the vestigial `status` parameter and the `if (true)` wrapper around the lanes.
4. Replace each bare `return` / fall-through with a `SettleOutcome`.

Move these imports across from `actions/refund.ts`: `db`, the `db/queries` names, `productsOrder`, `and`/`eq`/`inArray`, `getFeeTable`, `resolveZone`, `centsToEuros`/`feesForCountry`/`feesForWeight`, `loadBasket`, `releaseExchangeReservation`, `alertOps`. Leave `isAdmin` and `revalidatePath` behind.

The outcomes to return, one per existing exit:

```ts
if (!trustedLine)        return { settled: false, reason: "no-such-line" };
if (trustedLine.refunded) return { settled: false, reason: "already-refunded" };
// credit lane, after the productsOrder update:
                          return { settled: true, lane: "credit" };
// credit lane, when processGiftCardReturn failed:
                          return { settled: false, reason: "gift-card-failed" };
// exchange lane, when pending.length === 0:
                          return { settled: false, reason: "no-pending-exchange-lines" };
// exchange lane, after the productsOrder update:
                          return { settled: true, lane: "exchange" };
// exchange lane, when createOrder failed:
                          return { settled: false, reason: "exchange-order-failed" };
// refund lane, after the productsOrder update:
                          return { settled: true, lane: "refund" };
// refund lane, when createRefund failed or ids were missing:
                          return { settled: false, reason: "refund-failed" };
```

Add this docblock at the top of the file:

```ts
/**
 * Settling one returned garment: gift card, exchange, or refund.
 *
 * Lifted out of `validateReturn` so the dashboard button and the auto-approve
 * cron run the SAME payout. Two callers, one implementation — the €5 return-leg
 * deduction and the ×1.15 credit multiplier already live in four places across
 * this codebase, and must not gain a fifth by being copied into a cron.
 *
 * Deliberately unauthenticated and deliberately not cache-invalidating: both are
 * the caller's job, because the two callers need different answers. Never
 * import this from a client component.
 */
```

- [ ] **Step 3: Reduce `actions/refund.ts` to the authorised wrapper**

Replace the whole of `actions/refund.ts` with:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/requireAdmin";
import { settleReturnLine } from "@/lib/settleReturn";

/**
 * The dashboard's settle button.
 *
 * This action mints gift cards and issues refunds, with `product` and `order`
 * supplied by the caller. It is a server action, so being rendered inside
 * /dashboard protects the BUTTON, not this endpoint: middleware matches routes,
 * and an action is not a route. Without this gate an anonymous caller could mint
 * a card of any value. Return silently rather than throwing — the caller ignores
 * the result, and an unauthenticated caller should learn nothing.
 *
 * `status` is unused and kept only because ReturnsTable passes it.
 */
export async function validateReturn(product: any, status: string, order: any) {
  "use server";

  if (!(await isAdmin())) {
    console.error("validateReturn: rejected a call without an admin session");
    return;
  }

  const outcome = await settleReturnLine(product, order);
  if (outcome.settled) revalidatePath("/", "layout");
}
```

- [ ] **Step 4: Run the safety net — it must pass unedited**

Run: `npx vitest run tests/adminActions.test.ts tests/exchangeOrderBatching.test.ts tests/selfBookedSettlement.test.ts tests/orderNoteStoreCredit.test.ts`
Expected: PASS, same count as Step 1, **with no edits to any test file**.

Then the whole suite: `npm test` → 727 passing.
Then: `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/settleReturn.ts actions/refund.ts
git commit -m "refactor: extract the settlement core so a cron can share it with the button"
```

---

### Task 5: The cron route

**Files:**
- Create: `app/api/cron/auto-approve/route.ts`
- Test: `tests/autoApproveRoute.test.ts`

**Interfaces:**
- Consumes: `decideAutoApprove` (Task 1), `getReturnStatusesByIds` (Task 2), `getOrdersWithUnsettledReturns` (Task 3), `settleReturnLine` (Task 4), plus the existing `getAmphoraReturns`, `matchReturnsToOrderIds`, `getVariantSkusByIds`, `alertOps`.
- Produces: `GET(req: Request)` returning `{ scanned, settled, held, capped, dry }`.

- [ ] **Step 1: Write the failing test**

Create `tests/autoApproveRoute.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// This route pays customers with no human in the loop. It is PUBLIC —
// middleware.ts matches only /dashboard and /login — so CRON_SECRET is the only
// thing in front of it, and an unset secret must close it rather than open it.
//
// It must also be dry by default: an operator who deploys without setting
// AUTO_APPROVE_ENABLED gets a report, not a hundred payouts.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const RECEIVED_LONG_AGO = "2026-08-17T12:56:05";

const state = {
  returns: [] as any[],
  orders: [] as any[],
  shopifyStatuses: {} as Record<string, string>,
  skus: {} as Record<string, string>,
  settleThrowsOn: null as string | null,
};
const settled: string[] = [];
const alerts: string[] = [];

vi.mock("@/actions/amphora", () => ({ getAmphoraReturns: async () => state.returns }));
vi.mock("@/db/queries", () => ({
  getOrdersWithUnsettledReturns: async () => state.orders,
  getReturnStatusesByIds: async () => state.shopifyStatuses,
  getVariantSkusByIds: async () => state.skus,
}));
vi.mock("@/lib/settleReturn", () => ({
  settleReturnLine: async (product: any) => {
    if (state.settleThrowsOn === product.variant_id) throw new Error("shopify down");
    settled.push(product.variant_id);
    return { settled: true, lane: "refund" };
  },
}));
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => { alerts.push(subject); },
}));

function order(id: string, variantIds: string[]) {
  return {
    id,
    orderNumber: `#${id}`,
    products: variantIds.map((v) => ({
      id: `line-${v}`, variant_id: v, quantity: 1, confirmed: true, refunded: false,
      return_id: `gid://shopify/Return/${v}`, price: "50", action: "DEVOLUCIÓN", credit: false,
    })),
  };
}
function amphoraReturn(orderId: string, skus: string[], over: any = {}) {
  return {
    id: `SHP ${orderId}`, name: `#${orderId}`, external_id: orderId,
    internal_status: "RECEIVED", time_received: RECEIVED_LONG_AGO,
    items: skus.map((sku) => ({ sku, quantity: "1", quantity_received: "1" })),
    ...over,
  };
}

async function call(headers: Record<string, string> = {}, query = "") {
  const { GET } = await import("@/app/api/cron/auto-approve/route");
  return GET(new Request(`https://x.test/api/cron/auto-approve${query}`, { headers }));
}

beforeEach(() => {
  settled.length = 0;
  alerts.length = 0;
  state.orders = [order("1001", ["v1"])];
  state.returns = [amphoraReturn("1001", ["SKU1"])];
  state.shopifyStatuses = { "gid://shopify/Return/v1": "OPEN" };
  state.skus = { v1: "SKU1" };
  state.settleThrowsOn = null;
  process.env.CRON_SECRET = "s3cret";
  process.env.AUTO_APPROVE_ENABLED = "true";
  delete process.env.AUTO_APPROVE_MAX_PER_RUN;
  delete process.env.AUTO_APPROVE_GRACE_DAYS;
});

describe("auto-approve cron — authorisation", () => {
  it("401s when no secret is configured, rather than running open", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ authorization: "Bearer anything" });
    expect(res.status).toBe(401);
    expect(settled).toHaveLength(0);
  });

  it("401s on a wrong bearer", async () => {
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(settled).toHaveLength(0);
  });

  it("401s when the header is missing entirely", async () => {
    expect((await call()).status).toBe(401);
    expect(settled).toHaveLength(0);
  });
});

describe("auto-approve cron — settling", () => {
  it("settles an eligible line", async () => {
    const res = await call({ authorization: "Bearer s3cret" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(settled).toEqual(["v1"]);
    expect(body.settled).toBe(1);
  });

  it("does not settle a return Shopify has already closed", async () => {
    state.shopifyStatuses = { "gid://shopify/Return/v1": "CLOSED" };
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "shopify-not-open:CLOSED" });
  });

  it("does not settle when the warehouse is a garment short", async () => {
    state.returns = [amphoraReturn("1001", ["SKU1"], {
      items: [{ sku: "SKU1", quantity: "1", quantity_received: "0" }],
    })];
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "short-receipt:SKU1" });
  });

  it("holds every line on an order when one sibling is short", async () => {
    state.orders = [order("1001", ["v1", "v2"])];
    state.skus = { v1: "SKU1", v2: "SKU2" };
    state.shopifyStatuses = {
      "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
    };
    state.returns = [amphoraReturn("1001", [], { items: [
      { sku: "SKU1", quantity: "1", quantity_received: "1" },
      { sku: "SKU2", quantity: "1", quantity_received: "0" },
    ] })];
    await call({ authorization: "Bearer s3cret" });
    expect(settled).toHaveLength(0);
  });

  it("holds an order with no Amphora record at all", async () => {
    state.returns = [];
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "no-amphora-record" });
  });
});

describe("auto-approve cron — throttles", () => {
  it("stops at the per-run cap and reports the remainder", async () => {
    state.orders = [order("1001", ["v1"]), order("1002", ["v2"]), order("1003", ["v3"])];
    state.skus = { v1: "SKU1", v2: "SKU2", v3: "SKU3" };
    state.shopifyStatuses = {
      "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
      "gid://shopify/Return/v3": "OPEN",
    };
    state.returns = [
      amphoraReturn("1001", ["SKU1"]), amphoraReturn("1002", ["SKU2"]), amphoraReturn("1003", ["SKU3"]),
    ];
    process.env.AUTO_APPROVE_MAX_PER_RUN = "2";

    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(2);
    expect(body.capped).toBe(true);
  });

  it("is DRY when AUTO_APPROVE_ENABLED is unset — a deploy alone pays nobody", async () => {
    delete process.env.AUTO_APPROVE_ENABLED;
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.dry).toBe(true);
    expect(body.settled).toBe(1); // reports what it WOULD have settled
  });

  it("is DRY on ?dry=1 even when armed", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" }, "?dry=1")).json();
    expect(settled).toHaveLength(0);
    expect(body.dry).toBe(true);
  });
});

describe("auto-approve cron — resilience", () => {
  it("keeps settling after one line throws, and alerts on it", async () => {
    state.orders = [order("1001", ["v1"]), order("1002", ["v2"])];
    state.skus = { v1: "SKU1", v2: "SKU2" };
    state.shopifyStatuses = {
      "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
    };
    state.returns = [amphoraReturn("1001", ["SKU1"]), amphoraReturn("1002", ["SKU2"])];
    state.settleThrowsOn = "v1";

    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toEqual(["v2"]);
    expect(alerts.join(" ")).toContain("AUTO-APPROVE");
    expect(body.settled).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/autoApproveRoute.test.ts`
Expected: FAIL — cannot resolve `@/app/api/cron/auto-approve/route`.

- [ ] **Step 3: Write the implementation**

Create `app/api/cron/auto-approve/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getAmphoraReturns } from "@/actions/amphora";
import {
  getOrdersWithUnsettledReturns,
  getReturnStatusesByIds,
  getVariantSkusByIds,
} from "@/db/queries";
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";
import { decideAutoApprove, type GateLine } from "@/lib/autoApproveGate";
import { settleReturnLine } from "@/lib/settleReturn";
import { alertOps } from "@/actions/opsAlert";

/**
 * Settle the returns that are already sitting in the warehouse.
 *
 * Every return in this business is settled by hand today: a human opens the
 * dashboard, decides the return is fine, and clicks. For the overwhelming
 * majority they are confirming two facts — the goods came back, and we have not
 * already paid — and both are readable. This job reads them.
 *
 * DRY BY DEFAULT. `AUTO_APPROVE_ENABLED` must be set to "true" before a single
 * euro moves, so deploying this route does nothing until someone deliberately
 * arms it.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret =
 *  closed, never open — this route pays customers. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  // Armed only by an explicit env var. An operator who deploys and forgets gets
  // a report, not a hundred payouts.
  const dry =
    url.searchParams.get("dry") === "1" || process.env.AUTO_APPROVE_ENABLED !== "true";
  const cap = intEnv("AUTO_APPROVE_MAX_PER_RUN", 25);
  const graceDays = intEnv("AUTO_APPROVE_GRACE_DAYS", 2);

  let returns;
  try {
    returns = await getAmphoraReturns();
  } catch (error: any) {
    console.error("[auto-approve] could not list returns:", error?.message || error);
    return NextResponse.json({ error: "Amphora unreachable" }, { status: 502 });
  }

  const amphoraByOrderId = new Map(
    matchReturnsToOrderIds(returns).map((m) => [m.orderId, m.ret])
  );
  const orders = await getOrdersWithUnsettledReturns();

  // One batched Shopify read for the whole run, not one per order.
  const allReturnIds = orders.flatMap((o: any) =>
    o.products.filter((p: any) => !p.refunded && p.return_id).map((p: any) => p.return_id)
  );
  let shopifyReturnStatus: Record<string, string | undefined>;
  try {
    shopifyReturnStatus = await getReturnStatusesByIds(allReturnIds);
  } catch (error: any) {
    // Without this we cannot tell paid from unpaid, and the whole point of the
    // job is not paying twice. Refuse the run.
    console.error("[auto-approve] could not read Shopify return statuses:", error?.message || error);
    return NextResponse.json({ error: "Shopify unreachable" }, { status: 502 });
  }

  const held: Array<{ order: string; reason: string }> = [];
  let scanned = 0;
  let settledCount = 0;
  let capped = false;

  for (const order of orders as any[]) {
    if (settledCount >= cap) {
      capped = true;
      break;
    }
    scanned += 1;

    try {
      const pendingRows = order.products.filter((p: any) => !p.refunded);
      const skusById = await getVariantSkusByIds(
        pendingRows.map((p: any) => String(p.variant_id))
      );

      const lines: GateLine[] = order.products.map((p: any) => ({
        id: String(p.id),
        variant_id: String(p.variant_id),
        quantity: Number(p.quantity),
        return_id: p.return_id ?? null,
        refunded: p.refunded ?? false,
        confirmed: p.confirmed ?? false,
        sku: skusById[String(p.variant_id)] ?? null,
      }));

      const verdict = decideAutoApprove({
        lines,
        amphora: (amphoraByOrderId.get(String(order.id)) as any) ?? null,
        shopifyReturnStatus,
        now: new Date(),
        graceDays,
      });

      if (!verdict.settle) {
        held.push({ order: order.orderNumber, reason: verdict.reason });
        continue;
      }

      for (const line of verdict.lines) {
        if (settledCount >= cap) {
          capped = true;
          break;
        }
        settledCount += 1;
        if (dry) {
          console.log(`[auto-approve] WOULD settle ${order.orderNumber} / ${line.variant_id}`);
          continue;
        }
        // The core re-reads the line from the database and refuses one already
        // marked refunded, which is what makes settling in a loop safe.
        const outcome = await settleReturnLine(
          order.products.find((p: any) => String(p.id) === line.id),
          order
        );
        if (outcome.settled) {
          console.log(`[auto-approve] settled ${order.orderNumber} / ${line.variant_id} (${outcome.lane})`);
        } else {
          settledCount -= 1;
          held.push({ order: order.orderNumber, reason: `settle-refused:${outcome.reason}` });
        }
      }
    } catch (error: any) {
      // One bad order must not stop the sweep — the rest are still owed their
      // money. Alert, because by here money may have half-moved.
      console.error(`[auto-approve] ${order.orderNumber} failed:`, error?.message || error);
      held.push({ order: order.orderNumber, reason: "threw" });
      await alertOps(
        `[returns] AUTO-APPROVE FAILED — order ${order.orderNumber}`,
        [
          `The daily auto-approve run threw while settling ${order.orderNumber}.`,
          `Money may have moved partially. Check the order in Shopify before re-running.`,
          `Error: ${error?.message || error}`,
        ].join("\n")
      );
    }
  }

  // Name the held orders. A bare count tells whoever is on call that something
  // is waiting but not which customer — the delay this job exists to end.
  if (held.length) {
    console.warn(
      `[auto-approve] held ${held.length}: ` +
        held.map((h) => `${h.order} (${h.reason})`).join(", ")
    );
  }

  return NextResponse.json({ scanned, settled: settledCount, held, capped, dry });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/autoApproveRoute.test.ts`
Expected: PASS, 12 tests.

Then the whole suite: `npm test` → 727 + 36 new = 763 passing.
Then: `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/auto-approve/route.ts tests/autoApproveRoute.test.ts
git commit -m "feat: daily cron settling returns already received in the warehouse"
```

---

### Task 6: Arm it

Separate from Task 5 on purpose: the route working and the route running are two different approvals.

**Files:**
- Modify: `vercel.json`
- Modify: `README.md` (the env-var section)

- [ ] **Step 1: Add the schedule**

Edit `vercel.json` — keep the existing `amphora-sync` entry untouched:

```json
{
  "crons": [
    { "path": "/api/cron/amphora-sync", "schedule": "*/15 * * * *" },
    { "path": "/api/cron/auto-approve", "schedule": "0 7 * * *" }
  ]
}
```

07:00 UTC — after the warehouse's overnight processing, before the working day, so a held order is waiting when someone arrives.

- [ ] **Step 2: Document the environment variables**

Add to the env-var section of `README.md`:

```markdown
| `AUTO_APPROVE_ENABLED` | Set to `true` to let the daily auto-approve cron actually pay. Anything else (including unset) makes it a dry run that logs what it would have settled. |
| `AUTO_APPROVE_GRACE_DAYS` | Days after Amphora's `time_received` before a return may settle. Default `2`. |
| `AUTO_APPROVE_MAX_PER_RUN` | Lines settled per daily run. Default `25`. |
```

- [ ] **Step 3: Verify, commit, deploy dry**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all green.

```bash
git add vercel.json README.md
git commit -m "chore: schedule the auto-approve cron, dry until explicitly armed"
```

Deploy by pushing to `main` (never `vercel --prod` — the CLI's active account drifts).

- [ ] **Step 4: Verify CRON_SECRET is actually set in production**

**This is a real, previously-observed failure.** `CRON_SECRET` has been unset in production before, which makes every cron 401 silently — the job appears deployed and never runs.

Run: `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer wrong" https://<prod-host>/api/cron/auto-approve`
Expected: `401` (proves the route is live).

Then, with the real secret, confirm a **dry** run returns 200 and a sensible body. If `CRON_SECRET` is unset, a *correct* bearer also 401s — that is the signature to look for. Setting it requires the Vercel dashboard **and a redeploy**.

- [ ] **Step 5: Watch one dry run, then arm**

Read the dry run's JSON: `scanned`, `settled` (what it *would* pay), `held` with reasons. Compare the picks against your own judgement on a handful of orders in the dashboard.

Only then set `AUTO_APPROVE_ENABLED=true` in Vercel and redeploy. The first armed run settles at most 25 lines; the ~116-line backlog drains over about five days.

---

## Self-review

**Spec coverage.** Settlement-core extraction → Task 4. Gate with all five conditions → Task 1. Daily route, kill switch, grace, cap, `?dry=1` → Task 5. Observability (named held orders) → Task 5 Step 3. Testing section → Tasks 1, 2, 5. Out-of-scope items are absent from every task, as intended.

**One deliberate deviation from the spec.** The spec describes a per-line fresh re-read before settling. Task 4 keeps that re-read *inside* the settlement core (`trustedLine`, plus its `already-refunded` guard), which is where it already lives, so the cron inherits it. Adding a second read in the route would be redundant. Behaviour matches the spec; the location differs.

**Type consistency.** `GateLine`/`GateVerdict` as defined in Task 1 are consumed unchanged in Task 5. `SettleOutcome` as defined in Task 4 is consumed unchanged in Task 5. `getReturnStatusesByIds` returns `Record<string, string>` in Task 2 and is read as `Record<string, string | undefined>` in Task 1 — deliberate: indexing a missing key yields `undefined`, which is exactly the "unreadable" case.

**Known gap, accepted.** Not one `EXCEPTION*` or `FINISHED_REJECTED` return exists in live data, so the gate's behaviour against a genuinely rejected return is unverified. The allowlist means it fails safe (holds for a human) rather than paying out — the right default, but untested against reality rather than proven.
