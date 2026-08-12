# Cancel a Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer cancel their return or exchange from the portal and get a full refund, but only while the parcel has not moved and no admin has settled it.

**Architecture:** One pure decision module (`lib/cancelEligibility.ts`) holds every rule. One server action (`actions/cancelReturn.ts`) orchestrates the reversals in a fixed order: cancel the Amphora return (abort everything if it fails), cancel the Shopify return, release the exchange stock hold, refund Stripe, reset our rows, email the customer. Correos labels cannot be voided — this was probed and settled — so the eligibility gate, not a carrier cancellation, is what makes the reversal honest.

**Tech Stack:** Next.js 14 App Router, server actions, Drizzle ORM on Neon (`neon-http`), Shopify Admin GraphQL 2025-01, Amphora Company API, Stripe 18.2.1 (API `2025-05-28.basil`), Postmark, vitest.

## Global Constraints

- **Read the spec first:** `docs/superpowers/specs/2026-08-12-cancel-return-design.md`. It carries the evidence behind decisions this plan only states.
- **TDD, strictly.** Write the test, run it, watch it fail for the right reason, then implement. Never write production code first.
- **`npx tsc --noEmit` before every push.** Vitest does not typecheck. An ES5 iterator spread once reached `main` and broke two production deploys for nine days.
- **This tsconfig sets no `target`**, so `tsc` defaults to ES5 and refuses to iterate a `Map`/`Set` iterator. Use `Array.from(x.values())`, never `[...x.values()]`.
- **Never trust a 2xx from an external write.** Correos returned `Resultado 0` while changing nothing; Amphora returned `201` while dropping `carrier_data`. Verify through a second, independent read where it matters.
- **Do NOT run `drizzle-kit push`.** There is no migration history and this database holds tables not modelled in `db/schema.ts`; push reads them as drift and proposes DROPs on live data. Hand-written DDL only.
- **Preview shares the production database.** There are no test orders. Any portal run writes to live customer data.
- **Amphora wire spelling is `APROVED`** — one P.
- **Amphora return id = `"SHP " + shopifyOrderId`**, via `amphoraOrderIdFromShopifyId`.
- **Every customer-visible string is a key in BOTH `lib/i18n/es.ts` and `lib/i18n/en.ts`.** `en.ts` is typed against `es.ts`, so a key added to one and not the other is a compile error.
- **Ops contact address:** `hello@shamelesscollective.com`.
- Run the suite with `npm test`. A single file: `npx vitest run tests/<name>.test.ts`.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `lib/trackingStatus.ts` | Modify | Add the pure tri-state `carrierMovement(payload)`. Existing `trackingPhase` / `parseCorreosTracking` untouched. |
| `actions/shipping.ts` | Modify | Add `readCarrierMovement(locator)` — the network wrapper. No label cancellation exists. |
| `lib/cancelEligibility.ts` | Create | **Pure.** Every rule about when cancelling is allowed. |
| `actions/amphora.ts` | Modify | Add `cancelAmphoraReturn(returnId)`. |
| `db/queries.ts` | Modify | Add `cancelShopifyReturn(returnId)` and `resetOrderReturn(orderId)`. |
| `db/schema.ts` | Modify | Add `stripePaymentIntent` column. |
| `app/api/webhooks/stripe/route.ts` | Modify | Persist `session.payment_intent`. |
| `actions/refundPayment.ts` | Create | Resolve the payment intent (stored, else Stripe lookup) and refund it. |
| `actions/opsAlert.ts` | Create | Durable failure notice by email — Vercel logs expire in ~1h. |
| `actions/cancelReturn.ts` | Create | The orchestrator. The only place the reversal order lives. |
| `app/[id]/components/returnStatusPanel.tsx` | Create | Shows the existing return + Cancel button or the blocking reason. |
| `app/[id]/page.tsx` | Modify | Compute eligibility server-side, render the panel. |
| `lib/i18n/es.ts`, `lib/i18n/en.ts` | Modify | Panel, reasons, confirm step, cancellation email copy. |

---

### Task 1: Tri-state carrier movement

The existing tracking read collapses "Correos answered, nothing has moved" and "we could not reach Correos" into one `sin_informacion`. Cancelling on the second refunds customers whose garments are in transit; blocking on the first means the button never appears. They must be separable.

**Files:**
- Modify: `lib/trackingStatus.ts` (append; do not alter `trackingPhase` or `parseCorreosTracking`)
- Modify: `actions/shipping.ts` (append near `obtainLastStatus`, around line 380)
- Test: `tests/carrierMovement.test.ts`

**Interfaces:**
- Consumes: existing `TrackingPhase`, `trackingPhase()` from `lib/trackingStatus.ts`
- Produces:
  - `export type CarrierMovement = "moved" | "not-moved" | "unreadable"`
  - `export function carrierMovement(payload: unknown): CarrierMovement` (pure)
  - `export async function readCarrierMovement(locator: string | null | undefined): Promise<CarrierMovement>` (in `actions/shipping.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/carrierMovement.test.ts`. The `prerregistrado` fixture is a real Correos response, captured 2026-08-12 from our own test label.

```ts
import { describe, expect, it } from "vitest";
import { carrierMovement } from "@/lib/trackingStatus";

// Whether the customer's parcel has entered the carrier network.
//
// This is the signal that decides whether cancelling a return is honest, so it
// must distinguish three things the old read collapsed into one:
//   moved       the parcel is with Correos; cancelling would refund someone
//               whose garment is already on its way to us
//   not-moved   Correos answered and holds only a pre-registration
//   unreadable  we learned nothing, and must not guess
//
// `unreadable` fails closed on purpose. Wrongly blocking costs a support
// email; wrongly allowing costs the refund AND the garment.

/** Real payload, captured from PQAZXT9800005390128110S on 2026-08-12. */
const PRERREGISTRADO = [
  {
    codEnvio: "PQAZXT9800005390128110S",
    eventos: [
      {
        fecEvento: "12/08/2026",
        horEvento: "00:38:48",
        codEvento: "A090000V",
        desFase: "PRE-ADMISIÓN",
        desTextoResumen: "Prerregistrado",
        desTextoAmpliado:
          "Envío prerregistrado en los sistemas de Correos pendiente de depósito",
      },
    ],
    error: { codError: "0", desError: "" },
  },
];

const withLastEvent = (resumen: string) => [
  {
    codEnvio: "PQ1ES",
    eventos: [
      { desTextoResumen: "Prerregistrado", desFase: "PRE-ADMISIÓN" },
      { desTextoResumen: resumen, desFase: "X" },
    ],
    error: { codError: "0", desError: "" },
  },
];

describe("carrierMovement", () => {
  it("reports a pre-registered parcel as not moved", () => {
    expect(carrierMovement(PRERREGISTRADO)).toBe("not-moved");
  });

  it("reports an accepted parcel as moved", () => {
    expect(carrierMovement(withLastEvent("Admitido."))).toBe("moved");
  });

  it("reports a parcel in transit as moved", () => {
    expect(carrierMovement(withLastEvent("EN TRÁNSITO"))).toBe("moved");
  });

  it("reports a delivered parcel as moved", () => {
    expect(carrierMovement(withLastEvent("Entregado"))).toBe("moved");
  });

  it("treats a carrier error block as unreadable", () => {
    const payload = [{ codEnvio: "PQ1ES", eventos: [], error: { codError: "1", desError: "no data" } }];
    expect(carrierMovement(payload)).toBe("unreadable");
  });

  it("treats an unrecognised wording as unreadable rather than guessing", () => {
    // trackingPhase maps unknown labels to sin_informacion. We do not know
    // whether that wording means the parcel moved, so we must not decide.
    expect(carrierMovement(withLastEvent("Algo que no reconocemos"))).toBe("unreadable");
  });

  it("treats a clean answer with no events as not moved", () => {
    const payload = [{ codEnvio: "PQ1ES", eventos: [], error: { codError: "0", desError: "" } }];
    expect(carrierMovement(payload)).toBe("not-moved");
  });

  it("treats junk as unreadable", () => {
    expect(carrierMovement(null)).toBe("unreadable");
    expect(carrierMovement("nope")).toBe("unreadable");
    expect(carrierMovement([])).toBe("unreadable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/carrierMovement.test.ts`
Expected: FAIL — `carrierMovement is not a function` / no export named `carrierMovement`.

- [ ] **Step 3: Implement the pure function**

Append to `lib/trackingStatus.ts`:

```ts
/** Whether the parcel has entered the carrier network. */
export type CarrierMovement = "moved" | "not-moved" | "unreadable";

/** Phases that mean the customer has handed the parcel over. */
const MOVED_PHASES: ReadonlyArray<TrackingPhase> = [
  "admitido",
  "en_transito",
  "en_reparto",
  "entregado",
  "incidencia",
];

/**
 * Has this parcel moved?
 *
 * Separate from `parseCorreosTracking`, which answers "what should the
 * dashboard show" and is free to collapse everything it cannot read into one
 * display state. This answers "may we cancel", where the difference between
 * "Correos says nothing has happened" and "Correos did not answer" decides
 * whether a refund is safe.
 *
 * `unreadable` covers an unrecognised wording too. A label we cannot map to a
 * phase might mean the parcel is in transit, and guessing in the permissive
 * direction refunds a customer whose garment is already on its way.
 */
export function carrierMovement(payload: unknown): CarrierMovement {
  const record = Array.isArray(payload) ? payload[0] : payload;
  if (!record || typeof record !== "object") return "unreadable";

  const row = record as Record<string, any>;

  const codError = row.error?.codError;
  if (codError != null && String(codError) !== "0") return "unreadable";

  const events = Array.isArray(row.eventos) ? row.eventos : [];
  const lastEvent = events.length ? events[events.length - 1] : null;
  if (!lastEvent) return "not-moved";

  const label =
    lastEvent.desTextoResumen || lastEvent.desFase || lastEvent.desTextoAmpliado;
  if (!label) return "not-moved";

  const phase = trackingPhase(String(label));
  if (MOVED_PHASES.indexOf(phase) !== -1) return "moved";
  if (phase === "prerregistrado") return "not-moved";
  return "unreadable";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/carrierMovement.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the network wrapper**

Append to `actions/shipping.ts`, immediately after `obtainLastStatus`:

```ts
/**
 * Ask Correos whether this parcel has moved.
 *
 * A null locator is "not-moved", not "unreadable": an international return
 * Amphora has not assigned a carrier to has no tracking number and certainly
 * has no parcel in transit — its movement is carried by the Amphora status
 * instead. A domestic return with no locator never got a label at all.
 *
 * Any transport failure is "unreadable", which blocks cancellation.
 */
export async function readCarrierMovement(
  locator: string | null | undefined
): Promise<CarrierMovement> {
  const username = process.env.USERNAME_CORREOS;
  const password = process.env.PASSWORD_CORREOS;
  if (!locator) return "not-moved";
  if (!username || !password) return "unreadable";

  const authToken = Buffer.from(`${username}:${password}`).toString("base64");
  const url = `https://localizador.correos.es/canonico/eventos_envio_servicio_auth/${encodeURIComponent(
    locator
  )}?codIdioma=ES&indUltEvento=S`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${authToken}`,
        "Content-Type": "application/json",
      },
    });
    return carrierMovement(response.data);
  } catch (error) {
    console.error(`Could not read movement for ${locator}:`, error);
    return "unreadable";
  }
}
```

Add `carrierMovement` and the `CarrierMovement` type to the existing
`@/lib/trackingStatus` import at the top of `actions/shipping.ts`.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors; every existing test still passes.

- [ ] **Step 7: Commit**

```bash
git add lib/trackingStatus.ts actions/shipping.ts tests/carrierMovement.test.ts
git commit -m "feat: tell 'parcel has not moved' apart from 'we could not ask'"
```

---

### Task 2: The eligibility rules

Every rule about when cancelling is allowed lives here, pure, so the whole matrix is testable without a network, a database or a rendered page.

**Files:**
- Create: `lib/cancelEligibility.ts`
- Test: `tests/cancelEligibility.test.ts`

**Interfaces:**
- Consumes: `CarrierMovement` from `lib/trackingStatus.ts` (Task 1)
- Produces:
  - `export type CancelBlockedReason = "no-return" | "already-settled" | "in-transit" | "carrier-unreadable"`
  - `export type CancelDecision = { cancellable: true } | { cancellable: false; reason: CancelBlockedReason }`
  - `export type CancellableOrder = { products?: Array<{ confirmed?: boolean | null; refunded?: boolean | null }> | null; returnStatus?: string | null }`
  - `export function cancelEligibility(order: CancellableOrder | null | undefined, movement: CarrierMovement): CancelDecision`

- [ ] **Step 1: Write the failing test**

Create `tests/cancelEligibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cancelEligibility } from "@/lib/cancelEligibility";

// When a customer may cancel their own return. Four signals block; anything
// else is allowed. Pure, so the whole matrix is cheap to state.

const confirmed = (extra: Record<string, unknown> = {}) => ({
  products: [{ confirmed: true, refunded: false }],
  returnStatus: null,
  ...extra,
});

describe("cancelEligibility", () => {
  it("allows cancelling a fresh return whose parcel has not moved", () => {
    expect(cancelEligibility(confirmed(), "not-moved")).toEqual({ cancellable: true });
  });

  it("refuses when there is no return at all", () => {
    expect(cancelEligibility({ products: [{ confirmed: false }] }, "not-moved")).toEqual({
      cancellable: false,
      reason: "no-return",
    });
  });

  it("refuses when the order cannot be read", () => {
    expect(cancelEligibility(null, "not-moved")).toEqual({
      cancellable: false,
      reason: "no-return",
    });
  });

  it("refuses once an admin has settled a line", () => {
    // validateReturn set this: a refund was issued, a gift card minted, or the
    // replacement exchange order created.
    const order = { products: [{ confirmed: true, refunded: true }], returnStatus: null };
    expect(cancelEligibility(order, "not-moved")).toEqual({
      cancellable: false,
      reason: "already-settled",
    });
  });

  it("refuses once the parcel is with the carrier", () => {
    expect(cancelEligibility(confirmed(), "moved")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });

  it("refuses when we cannot reach the carrier", () => {
    // Fails closed. Blocking costs an email; allowing costs the refund and the
    // garment.
    expect(cancelEligibility(confirmed(), "unreadable")).toEqual({
      cancellable: false,
      reason: "carrier-unreadable",
    });
  });

  it.each(["PENDING", "APROVED", null, undefined])(
    "allows cancelling while Amphora status is %s",
    (returnStatus) => {
      expect(cancelEligibility(confirmed({ returnStatus }), "not-moved")).toEqual({
        cancellable: true,
      });
    }
  );

  it.each([
    "TRAVELLING",
    "PROCESSING_WAREHOUSE",
    "RECEIVED",
    "FINISHED",
    "FINISHED_REJECTED",
    "EXCEPTION",
    "EXCEPTION_WAREHOUSE",
  ])("refuses once Amphora reports %s", (returnStatus) => {
    expect(cancelEligibility(confirmed({ returnStatus }), "not-moved")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });

  it("checks settlement before movement, so a settled return reads as settled", () => {
    const order = { products: [{ confirmed: true, refunded: true }], returnStatus: "RECEIVED" };
    expect(cancelEligibility(order, "moved")).toEqual({
      cancellable: false,
      reason: "already-settled",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cancelEligibility.test.ts`
Expected: FAIL — cannot resolve `@/lib/cancelEligibility`.

- [ ] **Step 3: Implement**

Create `lib/cancelEligibility.ts`:

```ts
// Pure — no database, no cookies, no network. Every rule about when a customer
// may cancel their own return lives here, so the whole matrix is testable
// without standing up a session or a carrier.
//
// The gate matters more than usual: Correos labels cannot be voided (probed
// 2026-08-12, see docs/superpowers/specs/2026-08-12-cancel-return-design.md).
// Nothing downstream can make an unsafe cancellation safe again, so this is
// the only thing standing between a refund and a garment already in transit.

import type { CarrierMovement } from "./trackingStatus";

export type CancelBlockedReason =
  | "no-return"
  | "already-settled"
  | "in-transit"
  | "carrier-unreadable";

export type CancelDecision =
  | { cancellable: true }
  | { cancellable: false; reason: CancelBlockedReason };

/** The order fields this module reads. Structural, so callers pass their own
 *  row without reshaping it. */
export type CancellableOrder = {
  products?: Array<{ confirmed?: boolean | null; refunded?: boolean | null }> | null;
  returnStatus?: string | null;
};

/** Amphora statuses that mean the collection has already happened. Wire
 *  spelling — `APROVED` has one P and is NOT in this list. */
const MOVED_STATUSES: ReadonlyArray<string> = [
  "TRAVELLING",
  "PROCESSING_WAREHOUSE",
  "RECEIVED",
  "FINISHED",
  "FINISHED_REJECTED",
  "EXCEPTION",
  "EXCEPTION_WAREHOUSE",
];

const blocked = (reason: CancelBlockedReason): CancelDecision => ({
  cancellable: false,
  reason,
});

/**
 * May this return be cancelled?
 *
 * Order of checks is meaningful. Settlement is tested before movement so that
 * a return which is both settled and delivered reports the more final of the
 * two — telling a customer "your parcel is on its way" when we have already
 * refunded them would be worse than useless.
 */
export function cancelEligibility(
  order: CancellableOrder | null | undefined,
  movement: CarrierMovement
): CancelDecision {
  if (!order || !Array.isArray(order.products)) return blocked("no-return");

  const lines = order.products;
  if (!lines.some((line) => line?.confirmed === true)) return blocked("no-return");
  if (lines.some((line) => line?.refunded === true)) return blocked("already-settled");

  const status = order.returnStatus ?? null;
  if (status && MOVED_STATUSES.indexOf(status) !== -1) return blocked("in-transit");

  if (movement === "moved") return blocked("in-transit");
  if (movement === "unreadable") return blocked("carrier-unreadable");

  return { cancellable: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cancelEligibility.test.ts`
Expected: PASS, 17 tests (the two `it.each` blocks expand to 4 and 7).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npm test
git add lib/cancelEligibility.ts tests/cancelEligibility.test.ts
git commit -m "feat: rules for when a return may still be cancelled"
```

---

### Task 3: Cancel an Amphora return

The only carrier reversal available in either lane. `PATCH /returns/{id}/cancel` was verified live on 2026-08-11 — the record then vanishes from `GET /returns` entirely.

**Files:**
- Modify: `actions/amphora.ts` (append after `approveAmphoraReturn`, ~line 290)
- Test: `tests/amphoraCancel.test.ts`

**Interfaces:**
- Consumes: existing private `amphoraRequest`, `AmphoraReturn` type
- Produces: `export async function cancelAmphoraReturn(returnId: string): Promise<AmphoraReturn>`

- [ ] **Step 1: Write the failing test**

Create `tests/amphoraCancel.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// Amphora is the only booking either lane lets us release. Correos exposes no
// cancellation reachable with our credentials, so if this call does not happen
// the warehouse expects a parcel that is never coming.

const calls: Array<{ method: string; url: string; data: unknown }> = [];
let failNext = false;

vi.mock("axios", () => ({
  default: {
    request: async (cfg: any) => {
      if (failNext) throw new Error("amphora 500");
      calls.push({ method: cfg.method, url: cfg.url, data: cfg.data });
      return { data: { return_order: { id: "SHP 123", internal_status: "CANCELLED" } } };
    },
  },
}));

beforeEach(() => {
  calls.length = 0;
  failNext = false;
  process.env.AMPHORA_API_KEY = "k";
  process.env.AMPHORA_TENANT_ID = "Shameless";
  process.env.AMPHORA_COMPANY_API_URL = "https://api.example.com/prod-integrations-api";
});

describe("cancelAmphoraReturn", () => {
  it("PATCHes the cancel endpoint for that return", async () => {
    const { cancelAmphoraReturn } = await import("@/actions/amphora");

    await cancelAmphoraReturn("SHP 123");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/returns/SHP%20123/cancel");
  });

  it("returns the cancelled return", async () => {
    const { cancelAmphoraReturn } = await import("@/actions/amphora");

    const result = await cancelAmphoraReturn("SHP 123");

    expect(result.id).toBe("SHP 123");
  });

  it("throws when Amphora refuses, so the caller can abort", async () => {
    // The orchestrator treats this as fatal: nothing else may run, because a
    // refund past this point would leave the warehouse expecting a parcel.
    const { cancelAmphoraReturn } = await import("@/actions/amphora");
    failNext = true;

    await expect(cancelAmphoraReturn("SHP 123")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/amphoraCancel.test.ts`
Expected: FAIL — `cancelAmphoraReturn` is not exported.

- [ ] **Step 3: Implement**

Append to `actions/amphora.ts`:

```ts
/**
 * Cancel a return. Verified live 2026-08-11: the record then disappears from
 * `GET /returns` entirely.
 *
 * Throws on a non-2xx (axios default), deliberately — `cancelReturnFunction`
 * treats a failure here as fatal and aborts before any money moves.
 */
export async function cancelAmphoraReturn(returnId: string): Promise<AmphoraReturn> {
  const data = await amphoraRequest<{ return_order: AmphoraReturn }>(
    "PATCH",
    `/returns/${encodeURIComponent(returnId)}/cancel`,
  );
  return data.return_order;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/amphoraCancel.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add actions/amphora.ts tests/amphoraCancel.test.ts
git commit -m "feat: cancel an Amphora return"
```

---

### Task 4: Shopify cancel and the row reset

Two reversal primitives on our own records. The reset needs its own writer: `updateFinalOrder(revert)` refuses outright to touch a row carrying a `return_id`, a guard added after #310957 where a catch-all revert wiped a live return. That guard must stay exactly as strict as it is — cancellation is a different, verified operation that has already cancelled the Shopify return before it writes.

`returnCancel(id: ID!)` was confirmed against the live 2025-01 schema by introspection; it takes the id and nothing else.

**Files:**
- Modify: `db/queries.ts` (append after `closeReturn`, ~line 503)
- Test: `tests/cancelPrimitives.test.ts`

**Interfaces:**
- Produces:
  - `export async function cancelShopifyReturn(returnId: string): Promise<{ success: boolean; errors?: unknown }>`
  - `export async function resetOrderReturn(orderId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/cancelPrimitives.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// The two reversals against our own records.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

// Every `.set()` the reset performs, in order. Which table each one targeted is
// deliberately NOT recorded: the assertions identify updates by the columns
// they write, which is the behaviour under test, and reaching into Drizzle's
// internal table symbols to learn the name would couple the test to the ORM's
// private shape for no gain.
const setCalls: Array<Record<string, any>> = [];

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      setCalls.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

let shopifyBody = "";
const shopifyResponse = { value: { data: { returnCancel: { return: { id: "gid://x" }, userErrors: [] } } } };

global.fetch = (async (_url: string, init: any) => {
  shopifyBody = String(init.body);
  return { json: async () => shopifyResponse.value };
}) as any;

beforeEach(() => {
  setCalls.length = 0;
  shopifyBody = "";
  shopifyResponse.value = { data: { returnCancel: { return: { id: "gid://x" }, userErrors: [] } } };
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.myshopify.com";
});

describe("cancelShopifyReturn", () => {
  it("sends returnCancel for that return id", async () => {
    const { cancelShopifyReturn } = await import("@/db/queries");

    const result = await cancelShopifyReturn("gid://shopify/Return/1");

    expect(shopifyBody).toContain("returnCancel");
    expect(shopifyBody).toContain("gid://shopify/Return/1");
    expect(result.success).toBe(true);
  });

  it("reports failure on userErrors rather than throwing", async () => {
    // The caller has already cancelled Amphora and cannot undo it, so it needs
    // a value it can act on, not an exception mid-chain.
    shopifyResponse.value = {
      data: { returnCancel: { return: null, userErrors: [{ field: "id", message: "nope" }] } },
    } as any;
    const { cancelShopifyReturn } = await import("@/db/queries");

    const result = await cancelShopifyReturn("gid://shopify/Return/1");

    expect(result.success).toBe(false);
  });
});

describe("resetOrderReturn", () => {
  it("clears the tracking the cancelled return carried", async () => {
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const orderUpdate = setCalls.find((c) => "locator" in c);
    expect(orderUpdate).toMatchObject({
      locator: null,
      carrier: null,
      carrierUrl: null,
      returnStatus: null,
    });
  });

  it("clears the confirmation and the Shopify return ids from every line", async () => {
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const lineUpdate = setCalls.find((c) => "confirmed" in c);
    expect(lineUpdate).toMatchObject({
      confirmed: false,
      return_id: null,
      return_line_item_id: null,
    });
  });

  it("clears the customer's selections so they get a clean wizard", async () => {
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const lineUpdate = setCalls.find((c) => "confirmed" in c);
    expect(lineUpdate).toMatchObject({
      action: null,
      reason: null,
      notes: null,
      new_variant_id: null,
      new_variant_title: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cancelPrimitives.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement**

Append to `db/queries.ts`:

```ts
/**
 * Cancel a Shopify return.
 *
 * `returnCancel(id: ID!)` takes the id and nothing else — confirmed by schema
 * introspection against 2025-01.
 *
 * Reports failure rather than throwing. Its only caller has already cancelled
 * the Amphora return and cannot undo that, so it must be able to carry on and
 * alert a human instead of dying mid-chain.
 */
export async function cancelShopifyReturn(
  returnId: string
): Promise<{ success: boolean; errors?: unknown }> {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  const query = `
    mutation CancelReturn($id: ID!) {
      returnCancel(id: $id) {
        return { id status }
        userErrors { field message }
      }
    }
  `;

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: (session as any).headers,
      body: JSON.stringify({ query, variables: { id: returnId } }),
    });
    const data = await response.json();
    const userErrors = data?.data?.returnCancel?.userErrors ?? [];

    if (data.errors || userErrors.length > 0) {
      console.error("Error cancelling return:", data.errors || userErrors);
      return { success: false, errors: data.errors || userErrors };
    }
    return { success: true };
  } catch (error) {
    console.error("Fetch error cancelling return:", error);
    return { success: false, errors: error };
  }
}

/**
 * Put an order back to the state it was in before the customer submitted.
 *
 * NOT `updateFinalOrder(revert)`. That path refuses to reset any row carrying a
 * `return_id` — a guard added after #310957, where a catch-all revert wiped a
 * live Shopify return and left the customer with nothing. The guard is correct
 * and stays. This function is the deliberate counterpart: it runs only after
 * eligibility has been verified and the Shopify return has actually been
 * cancelled, so clearing the id records reality rather than hiding it.
 */
export async function resetOrderReturn(orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({ locator: null, carrier: null, carrierUrl: null, returnStatus: null })
    .where(eq(orders.id, orderId));

  await db
    .update(productsOrder)
    .set({
      confirmed: false,
      return_id: null,
      return_line_item_id: null,
      action: null,
      reason: null,
      notes: null,
      new_variant_id: null,
      new_variant_title: null,
    })
    .where(eq(productsOrder.orderId, orderId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cancelPrimitives.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit && npm test
git add db/queries.ts tests/cancelPrimitives.test.ts
git commit -m "feat: cancel a Shopify return and reset the order rows"
```

---

### Task 5: The refund

Two halves: start storing the payment intent, and recover it for returns booked before this ships. `checkout.sessions.list` accepts `customer_details.email`, `status` and `created` — verified against the pinned SDK's `SessionListParams`. Stripe's Search API does **not** cover Checkout Sessions and our metadata is never copied onto the PaymentIntent, so listing is the only recovery route.

**Files:**
- Modify: `db/schema.ts` (in `orders`, after `exchangeReservationId`)
- Modify: `README.md` (migration section — record the DDL)
- Modify: `app/api/webhooks/stripe/route.ts`
- Create: `actions/refundPayment.ts`
- Test: `tests/refundPayment.test.ts`

**Interfaces:**
- Produces:
  - `export type RefundOutcome = { refunded: boolean; reason?: "no-payment" | "not-found" | "error" }`
  - `export async function refundOrderPayment(order: { id: string; email: string; stripePaymentIntent?: string | null }): Promise<RefundOutcome>`

- [ ] **Step 1: Apply the DDL to production, by hand**

Do NOT run `drizzle-kit push`. Connect to the Neon project `dry-firefly-81844312`, database **ShamelessReturns** on `main`, and run:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_payment_intent text;
```

Apply this **before** deploying any code that reads the column. Append the statement to the migration section of `README.md` in the same commit as the schema change.

- [ ] **Step 2: Add the column to the schema**

In `db/schema.ts`, inside `orders`, after `exchangeReservationId`:

```ts
  // The PaymentIntent behind the customer's portal charge, so a cancellation
  // can refund it without a human searching Stripe. Written by the Stripe
  // webhook. Null for free returns, and for anything booked before 2026-08-12
  // — those are recovered by listing sessions for the customer's email.
  stripePaymentIntent: text("stripe_payment_intent"),
```

- [ ] **Step 3: Write the failing test**

Create `tests/refundPayment.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// Giving the customer their money back.
//
// Stored intent first; a session lookup for anything booked before the column
// existed. Idempotent, because a double click must not refund twice.

const refunds: Array<{ args: any; options: any }> = [];
const listCalls: any[] = [];
let sessions: any[] = [];
let refundThrows = false;

vi.mock("@/lib/stripe", () => ({
  stripe: {
    refunds: {
      create: async (args: any, options: any) => {
        if (refundThrows) throw new Error("stripe down");
        refunds.push({ args, options });
        return { id: "re_1" };
      },
    },
    checkout: {
      sessions: {
        list: (params: any) => {
          listCalls.push(params);
          return {
            autoPagingEach: async (fn: (s: any) => any) => {
              for (const s of sessions) if ((await fn(s)) === false) return;
            },
          };
        },
      },
    },
  },
}));

beforeEach(() => {
  refunds.length = 0;
  listCalls.length = 0;
  sessions = [];
  refundThrows = false;
});

const ORDER = { id: "13217168851270", email: "customer@example.com" };

describe("refundOrderPayment", () => {
  it("refunds the stored payment intent without touching the session list", async () => {
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" });

    expect(result).toEqual({ refunded: true });
    expect(refunds[0].args.payment_intent).toBe("pi_stored");
    expect(listCalls).toHaveLength(0);
  });

  it("keys the refund so a double submit cannot refund twice", async () => {
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" });

    expect(refunds[0].options.idempotencyKey).toBe(`cancel:${ORDER.id}`);
  });

  it("recovers the payment for a return booked before the column existed", async () => {
    sessions = [
      { metadata: { id: "someone-else" }, payment_intent: "pi_wrong" },
      { metadata: { id: ORDER.id }, payment_intent: "pi_found" },
    ];
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: null });

    expect(result).toEqual({ refunded: true });
    expect(refunds[0].args.payment_intent).toBe("pi_found");
    expect(listCalls[0].customer_details).toEqual({ email: ORDER.email });
    expect(listCalls[0].status).toBe("complete");
  });

  it("reports no-payment for a return that never owed anything", async () => {
    // createStripeUrl returned { data: null }: nothing was ever charged.
    sessions = [];
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: null });

    expect(result).toEqual({ refunded: false, reason: "not-found" });
    expect(refunds).toHaveLength(0);
  });

  it("reports an error rather than throwing when Stripe fails", async () => {
    // The label is already dead by the time this runs; the caller must be able
    // to finish the cancellation and alert a human.
    refundThrows = true;
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" });

    expect(result).toEqual({ refunded: false, reason: "error" });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/refundPayment.test.ts`
Expected: FAIL — cannot resolve `@/actions/refundPayment`.

- [ ] **Step 5: Implement**

Create `actions/refundPayment.ts`:

```ts
"use server";

import { stripe } from "@/lib/stripe";

export type RefundOutcome = {
  refunded: boolean;
  reason?: "not-found" | "error";
};

export type RefundableOrder = {
  id: string;
  email: string;
  stripePaymentIntent?: string | null;
};

/** How far back to look for a session when no intent was stored. `orders` has
 *  no timestamp column, so there is nothing to bound this by per-order. */
const LOOKUP_WINDOW_SECONDS = 90 * 24 * 60 * 60;

/** A customer with more paid checkouts than this in 90 days is not a real
 *  case; an unbounded scan on a cancel click is. */
const MAX_SESSIONS_SCANNED = 300;

/**
 * Find the PaymentIntent behind this order's portal charge.
 *
 * `createStripeUrl` sets `customer_email` and puts the order id in the session
 * metadata, which is what makes this recoverable at all. Stripe's Search API
 * does not cover Checkout Sessions, and the metadata is never copied onto the
 * PaymentIntent, so listing is the only route — which is why new charges store
 * the intent directly.
 */
async function resolvePaymentIntentId(order: RefundableOrder): Promise<string | null> {
  if (order.stripePaymentIntent) return order.stripePaymentIntent;

  const nowSeconds = Math.floor(Date.now() / 1000);
  let found: string | null = null;
  let scanned = 0;

  await stripe.checkout.sessions
    .list({
      customer_details: { email: order.email },
      status: "complete",
      created: { gte: nowSeconds - LOOKUP_WINDOW_SECONDS },
      limit: 100,
    })
    .autoPagingEach((session: any) => {
      scanned += 1;
      if (session?.metadata?.id === order.id && session.payment_intent) {
        found =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent.id;
        return false;
      }
      if (scanned >= MAX_SESSIONS_SCANNED) return false;
      return undefined;
    });

  return found;
}

/**
 * Refund everything the customer paid in the portal: the return fee, any
 * exchange price difference, and both shipping legs.
 *
 * Never throws. By the time this runs the Amphora return is already cancelled
 * and — for Spain — the label is dead, so the caller must be able to finish the
 * cancellation and raise an alert rather than die here.
 *
 * The idempotency key is the order id, so a double click, a retry or a
 * resubmitted action all collapse onto one refund.
 */
export async function refundOrderPayment(order: RefundableOrder): Promise<RefundOutcome> {
  try {
    const paymentIntent = await resolvePaymentIntentId(order);
    if (!paymentIntent) return { refunded: false, reason: "not-found" };

    await stripe.refunds.create(
      { payment_intent: paymentIntent },
      { idempotencyKey: `cancel:${order.id}` }
    );
    return { refunded: true };
  } catch (error) {
    console.error(`Refund failed for order ${order.id}:`, error);
    return { refunded: false, reason: "error" };
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/refundPayment.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Persist the intent from the webhook**

In `app/api/webhooks/stripe/route.ts`, inside the `checkout.session.completed` branch, immediately after `const { id, isCredit } = metadata;`:

```ts
      // Store the payment before anything else can fail. A cancellation later
      // needs it to refund without a human searching Stripe by hand.
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null;
      if (paymentIntentId) {
        try {
          await db
            .update(orders)
            .set({ stripePaymentIntent: paymentIntentId })
            .where(eq(orders.id, id));
        } catch (error) {
          console.error(`Could not store payment intent for order ${id}:`, error);
        }
      }
```

Add the imports this needs at the top of the file:

```ts
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { eq } from "drizzle-orm";
```

- [ ] **Step 8: Typecheck and commit**

```bash
npx tsc --noEmit && npm test
git add db/schema.ts README.md app/api/webhooks/stripe/route.ts actions/refundPayment.ts tests/refundPayment.test.ts
git commit -m "feat: store the Stripe payment intent and refund it on cancellation"
```

---

### Task 6: The orchestrator

The only place the reversal order lives. Step 1 aborts everything; past it, each step continues on failure and raises a durable alert, because the customer is owed their money once the return is gone.

**Files:**
- Create: `actions/opsAlert.ts`
- Create: `actions/cancelReturn.ts`
- Test: `tests/cancelReturn.test.ts`

**Interfaces:**
- Consumes: `cancelEligibility`, `CancelBlockedReason` (Task 2); `readCarrierMovement` (Task 1); `cancelAmphoraReturn`, `amphoraOrderIdFromShopifyId` (Task 3); `cancelShopifyReturn`, `resetOrderReturn` (Task 4); `refundOrderPayment` (Task 5); existing `releaseExchangeReservation`, `hasOrderAccess`, `getOrderById`
- Produces:
  - `export async function alertOps(subject: string, body: string): Promise<void>` (in `actions/opsAlert.ts`)
  - `export type CancelResult = { ok: true } | { ok: false; reason: CancelBlockedReason | "carrier-cancel-failed" | "forbidden" }`
  - `export async function cancelReturnFunction(orderId: string): Promise<CancelResult>`

- [ ] **Step 1: Add the cancellation copy to both dictionaries**

The orchestrator sends the customer's email, so the copy has to exist before it
compiles. `en.ts` is typed against `es.ts`; adding a key to one and not the
other is a compile error.

In `lib/i18n/es.ts`, before the closing `} as const;`:

```ts
  cancel: {
    heading: "Tu devolución",
    trackingLabel: "Número de seguimiento",
    carrierLabel: "Transportista",
    button: "Cancelar mi devolución",
    confirmQuestion: "¿Seguro que quieres cancelar?",
    confirmDetail:
      "Te devolveremos todo lo que has pagado. La etiqueta que te enviamos dejará de ser válida.",
    confirmYes: "Sí, cancelar",
    confirmNo: "No, mantenerla",
    cancelling: "Cancelando...",
    doneTitle: "Hemos cancelado tu devolución",
    doneBody:
      "Te devolveremos el importe en el método de pago que usaste. No utilices la etiqueta que te enviamos.",
    blockedInTransit:
      "Tu paquete ya está de camino hacia nosotros, así que esta devolución ya no se puede cancelar.",
    blockedSettled:
      "Ya hemos procesado esta devolución, así que no se puede cancelar. Escríbenos si necesitas ayuda.",
    blockedUnreadable:
      "Ahora mismo no podemos comprobar el estado de tu paquete. Inténtalo de nuevo en unos minutos.",
    failed:
      "No hemos podido cancelar tu devolución. Escríbenos a hello@shamelesscollective.com con tu número de pedido.",
    emailSubject: "Hemos cancelado la devolución de tu pedido",
    emailBody:
      "Hemos cancelado tu devolución y te reembolsaremos lo que pagaste en el método de pago original.",
    emailLabelWarning:
      "IMPORTANTE: la etiqueta de envío que te enviamos ya no es válida. Si quieres devolver algo más adelante, empieza una nueva solicitud y te enviaremos una etiqueta nueva.",
  },
```

In `lib/i18n/en.ts`, the same keys with English text:

```ts
  cancel: {
    heading: "Your return",
    trackingLabel: "Tracking number",
    carrierLabel: "Carrier",
    button: "Cancel my return",
    confirmQuestion: "Are you sure you want to cancel?",
    confirmDetail:
      "We'll refund everything you paid. The label we sent you will stop working.",
    confirmYes: "Yes, cancel it",
    confirmNo: "No, keep it",
    cancelling: "Cancelling...",
    doneTitle: "We've cancelled your return",
    doneBody:
      "We'll refund you to the payment method you used. Please don't use the label we sent you.",
    blockedInTransit:
      "Your parcel is already on its way to us, so this return can no longer be cancelled.",
    blockedSettled:
      "We've already processed this return, so it can't be cancelled. Get in touch if you need a hand.",
    blockedUnreadable:
      "We can't check on your parcel right now. Please try again in a few minutes.",
    failed:
      "We couldn't cancel your return. Please email hello@shamelesscollective.com with your order number.",
    emailSubject: "We've cancelled the return for your order",
    emailBody:
      "We've cancelled your return and will refund what you paid to your original payment method.",
    emailLabelWarning:
      "IMPORTANT: the shipping label we sent you is no longer valid. If you'd like to return something later, start a new request and we'll send you a fresh label.",
  },
```

Then create `actions/opsAlert.ts`. No test of its own — its contract is asserted through the orchestrator's tests, where the thing that matters is *that an alert is raised on the failure paths*, not how it is transported.

```ts
"use server";

import axios from "axios";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";
const OPS_ADDRESS = "hello@shamelesscollective.com";

/**
 * Tell a human something needs fixing, durably.
 *
 * Vercel keeps runtime logs for about an hour, so `console.error` is not a
 * record that anyone will find tomorrow — a production freeze went unnoticed
 * for nine days behind exactly that assumption. Cancellation compounds it: the
 * row is cleared moments later, which drops it out of the dashboard too, so
 * the inbox becomes the only place the problem still exists.
 *
 * Best effort and silent on failure. It is already the fallback path.
 */
export async function alertOps(subject: string, body: string): Promise<void> {
  console.error(`[ops] ${subject}: ${body}`);

  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return;

  try {
    await axios.post(
      POSTMARK_API_URL,
      {
        From: OPS_ADDRESS,
        To: OPS_ADDRESS,
        Subject: subject,
        TextBody: body,
        MessageStream: "outbound",
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
      }
    );
  } catch (error: any) {
    console.error("Could not send ops alert:", error?.response?.data || error?.message);
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/cancelReturn.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// The reversal chain, in order.
//
// Step 1 (Amphora) aborts everything: it is the only booking either lane lets
// us release, and refunding past a failure there leaves the warehouse expecting
// a parcel forever.
//
// Past step 1 the logic inverts. The return is gone and, for Spain, the Correos
// label cannot be voided at all — so the customer is owed their money whatever
// else breaks. Later steps continue and raise a durable alert instead.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const calls = {
  amphoraCancel: [] as string[],
  shopifyCancel: [] as string[],
  releaseHold: [] as string[],
  refund: [] as string[],
  reset: [] as string[],
  customerEmail: [] as string[],
  opsAlert: [] as string[],
};

const behaviour = {
  access: true,
  movement: "not-moved" as "moved" | "not-moved" | "unreadable",
  amphoraFails: false,
  shopifyFails: false,
  refundOutcome: { refunded: true } as any,
};

const ORDER: Record<string, any> = {
  id: "13217168851270",
  orderNumber: "#311148",
  email: "customer@example.com",
  locale: "es",
  locator: "PQ1ES",
  returnStatus: "APROVED",
  stripePaymentIntent: "pi_stored",
  products: [{ confirmed: true, refunded: false, return_id: "gid://shopify/Return/1" }],
};

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => behaviour.access }));
vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  cancelShopifyReturn: async (id: string) => {
    calls.shopifyCancel.push(id);
    return behaviour.shopifyFails ? { success: false, errors: "nope" } : { success: true };
  },
  resetOrderReturn: async (id: string) => {
    calls.reset.push(id);
  },
}));
vi.mock("@/actions/shipping", () => ({
  readCarrierMovement: async () => behaviour.movement,
}));
vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  cancelAmphoraReturn: async (id: string) => {
    if (behaviour.amphoraFails) throw new Error("amphora 500");
    calls.amphoraCancel.push(id);
    return { id };
  },
}));
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async (id: string) => {
    calls.releaseHold.push(id);
    return true;
  },
}));
vi.mock("@/actions/refundPayment", () => ({
  refundOrderPayment: async (order: any) => {
    calls.refund.push(order.id);
    return behaviour.refundOutcome;
  },
}));
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => {
    calls.opsAlert.push(subject);
  },
}));
vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) calls.customerEmail.push(url);
      return { status: 200 };
    },
  },
}));

async function cancel() {
  const { cancelReturnFunction } = await import("@/actions/cancelReturn");
  return cancelReturnFunction(ORDER.id);
}

beforeEach(() => {
  for (const key of Object.keys(calls)) (calls as any)[key].length = 0;
  behaviour.access = true;
  behaviour.movement = "not-moved";
  behaviour.amphoraFails = false;
  behaviour.shopifyFails = false;
  behaviour.refundOutcome = { refunded: true };
  ORDER.products = [{ confirmed: true, refunded: false, return_id: "gid://shopify/Return/1" }];
  ORDER.returnStatus = "APROVED";
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("cancelling an eligible return", () => {
  it("reports success", async () => {
    expect(await cancel()).toEqual({ ok: true });
  });

  it("cancels the Amphora return for that order", async () => {
    await cancel();
    expect(calls.amphoraCancel).toEqual(["SHP 13217168851270"]);
  });

  it("cancels the Shopify return the lines carry", async () => {
    await cancel();
    expect(calls.shopifyCancel).toEqual(["gid://shopify/Return/1"]);
  });

  it("releases the exchange stock hold", async () => {
    await cancel();
    expect(calls.releaseHold).toEqual([ORDER.id]);
  });

  it("refunds the customer", async () => {
    await cancel();
    expect(calls.refund).toEqual([ORDER.id]);
  });

  it("resets the order to a clean slate", async () => {
    await cancel();
    expect(calls.reset).toEqual([ORDER.id]);
  });

  it("emails the customer", async () => {
    await cancel();
    expect(calls.customerEmail).toHaveLength(1);
  });
});

describe("when the return may not be cancelled", () => {
  it("refuses a caller with no session, and touches nothing", async () => {
    behaviour.access = false;
    expect(await cancel()).toEqual({ ok: false, reason: "forbidden" });
    expect(calls.amphoraCancel).toHaveLength(0);
    expect(calls.refund).toHaveLength(0);
  });

  it("refuses once the parcel has moved, even if the action is called directly", async () => {
    behaviour.movement = "moved";
    expect(await cancel()).toEqual({ ok: false, reason: "in-transit" });
    expect(calls.refund).toHaveLength(0);
  });

  it("refuses when the carrier cannot be reached", async () => {
    behaviour.movement = "unreadable";
    expect(await cancel()).toEqual({ ok: false, reason: "carrier-unreadable" });
    expect(calls.amphoraCancel).toHaveLength(0);
  });

  it("refuses once an admin has settled it", async () => {
    ORDER.products = [{ confirmed: true, refunded: true, return_id: "gid://shopify/Return/1" }];
    expect(await cancel()).toEqual({ ok: false, reason: "already-settled" });
    expect(calls.refund).toHaveLength(0);
  });
});

describe("when a step fails", () => {
  it("aborts before any money moves if Amphora will not cancel", async () => {
    behaviour.amphoraFails = true;

    expect(await cancel()).toEqual({ ok: false, reason: "carrier-cancel-failed" });
    expect(calls.shopifyCancel).toHaveLength(0);
    expect(calls.refund).toHaveLength(0);
    expect(calls.reset).toHaveLength(0);
  });

  it("still refunds when Shopify will not cancel, and alerts a human", async () => {
    // The return is already gone from Amphora. Stopping here would leave the
    // customer with no return and no money.
    behaviour.shopifyFails = true;

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.refund).toEqual([ORDER.id]);
    expect(calls.opsAlert.length).toBeGreaterThan(0);
  });

  it("alerts a human when the refund cannot be issued", async () => {
    behaviour.refundOutcome = { refunded: false, reason: "error" };

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.opsAlert.length).toBeGreaterThan(0);
    expect(calls.reset).toEqual([ORDER.id]);
  });

  it("does not alert for a return that never owed anything", async () => {
    // A free return has nothing to refund; that is not a failure.
    behaviour.refundOutcome = { refunded: false, reason: "not-found" };

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.opsAlert).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/cancelReturn.test.ts`
Expected: FAIL — cannot resolve `@/actions/cancelReturn`.

- [ ] **Step 4: Implement**

Create `actions/cancelReturn.ts`:

```ts
"use server";

import axios from "axios";
import { getOrderById, cancelShopifyReturn, resetOrderReturn } from "@/db/queries";
import { hasOrderAccess } from "@/lib/orderAccess";
import { cancelEligibility, type CancelBlockedReason } from "@/lib/cancelEligibility";
import { readCarrierMovement } from "./shipping";
import { amphoraOrderIdFromShopifyId, cancelAmphoraReturn } from "./amphora";
import { releaseExchangeReservation } from "./exchangeReservation";
import { refundOrderPayment } from "./refundPayment";
import { alertOps } from "./opsAlert";
import { dictionaries, readLocale } from "@/lib/i18n";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

export type CancelResult =
  | { ok: true }
  | { ok: false; reason: CancelBlockedReason | "carrier-cancel-failed" | "forbidden" };

/**
 * Cancel a customer's return or exchange and give them their money back.
 *
 * The order of reversals is the whole design, and it changes meaning halfway
 * through:
 *
 *   1. Amphora cancel  — FATAL. The only booking either lane lets us release.
 *   2. Shopify cancel  — continue on failure, alert a human.
 *   3. Release hold    — best effort, never throws.
 *   4. Stripe refund   — continue on failure, alert a human.
 *   5. Reset our rows.
 *   6. Email the customer.
 *
 * Past step 1 the customer's return no longer exists and, for Spain, their
 * Correos label cannot be voided (probed 2026-08-12: BajaOp rejects our
 * shipments, AnularOp needs Oid/Eid we cannot obtain). So they are owed their
 * refund whatever else breaks, and a partial failure becomes an ops problem
 * rather than a reason to strand them.
 */
export async function cancelReturnFunction(orderId: string): Promise<CancelResult> {
  // `orders.id` is the raw sequential Shopify order id. Without this, knowing a
  // number would let anyone cancel a stranger's return and refund their card.
  if (!(await hasOrderAccess(orderId))) {
    console.error(`cancelReturnFunction: rejected a call without a session for ${orderId}`);
    return { ok: false, reason: "forbidden" };
  }

  const order = await getOrderById(orderId);
  const movement = await readCarrierMovement(order?.locator);
  const decision = cancelEligibility(order as any, movement);
  if (!decision.cancellable) return { ok: false, reason: decision.reason };

  // 1. FATAL. Nothing below runs if the warehouse still expects the parcel.
  try {
    await cancelAmphoraReturn(amphoraOrderIdFromShopifyId(orderId));
  } catch (error: any) {
    console.error(
      `Cancel aborted for ${orderId}: Amphora would not cancel the return:`,
      error?.message || error
    );
    return { ok: false, reason: "carrier-cancel-failed" };
  }

  // 2. Continue on failure — an open Shopify return is an ops problem, and
  //    stopping here would leave the customer with no return and no money.
  const returnId = (order as any)?.products?.find((line: any) => line?.return_id)?.return_id;
  if (returnId) {
    const cancelled = await cancelShopifyReturn(returnId);
    if (!cancelled.success) {
      await alertOps(
        `Shopify return ${returnId} still open after cancellation (${(order as any).orderNumber})`,
        `Order ${orderId} was cancelled by the customer and refunded, but returnCancel failed:\n` +
          `${JSON.stringify(cancelled.errors)}\n\n` +
          `Close it by hand, or an admin validating it later will refund the garment too.`
      );
    }
  }

  // 3. Best effort by contract; never throws.
  await releaseExchangeReservation(orderId);

  // 4. `not-found` is not a failure: a free return had nothing to refund.
  const refund = await refundOrderPayment({
    id: orderId,
    email: (order as any).email,
    stripePaymentIntent: (order as any).stripePaymentIntent,
  });
  if (!refund.refunded && refund.reason === "error") {
    await alertOps(
      `Refund FAILED after cancelling ${(order as any).orderNumber}`,
      `Order ${orderId} was cancelled at the customer's request and their return is gone, ` +
        `but the refund did not go through. Refund them by hand in Stripe.`
    );
  }

  // 5. Clean slate — they can start a fresh return immediately.
  await resetOrderReturn(orderId);

  // 6. Tell them, in the language they used.
  await sendCancellationEmail(order as any);

  return { ok: true };
}

/**
 * Best effort. The cancellation is already done and correct; failing to
 * announce it must not report failure to a customer whose return is gone.
 */
async function sendCancellationEmail(order: {
  email: string;
  locale?: string | null;
  orderNumber: string;
}): Promise<void> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return;

  const t = dictionaries[readLocale(order.locale)];
  try {
    await axios.post(
      POSTMARK_API_URL,
      {
        From: "hello@shamelesscollective.com",
        To: order.email,
        Subject: `${t.cancel.emailSubject} ${order.orderNumber}`,
        TextBody: `${t.cancel.emailBody}\n\n${t.cancel.emailLabelWarning}`,
        MessageStream: "outbound",
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
      }
    );
  } catch (error: any) {
    console.error(`Cancellation email failed for ${order.orderNumber}:`, error?.message);
  }
}
```

`t.cancel.*` comes from Step 1 of this task, so this compiles as written.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/cancelReturn.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit && npm test
git add actions/cancelReturn.ts actions/opsAlert.ts tests/cancelReturn.test.ts
git commit -m "feat: cancel a return, reverse it in order, refund the customer"
```

---

### Task 7: The screen

**Files:**
- Modify: `lib/i18n/es.ts`, `lib/i18n/en.ts`
- Create: `app/[id]/components/returnStatusPanel.tsx`
- Modify: `app/[id]/page.tsx`
- Test: `tests/returnStatusPanel.test.ts`

**Interfaces:**
- Consumes: `CancelDecision`, `CancelBlockedReason` (Task 2); `cancelReturnFunction` (Task 6)
- Produces: `export function ReturnStatusPanel(props: { decision: CancelDecision; orderId: string; locator: string | null; carrier: string | null })`

- [ ] **Step 1: Confirm the copy is already in place**

The `cancel:` block was added to both `lib/i18n/es.ts` and `lib/i18n/en.ts` in
Task 6 Step 1, because the cancellation email needed it to compile. Verify it
is there before building the panel against it:

```bash
grep -c 'blockedInTransit' lib/i18n/es.ts lib/i18n/en.ts
```

Expected: `1` for each file. If either is `0`, add the block from Task 6 Step 1
before continuing — `en.ts` is typed against `es.ts`, so a key in one and not
the other is a compile error.

- [ ] **Step 2: Write the failing test**

Create `tests/returnStatusPanel.test.ts`. It tests the copy-selection rule, not the markup — that is the part that can silently tell a customer the wrong thing.

```ts
import { describe, expect, it } from "vitest";
import { blockedMessageKey } from "@/app/[id]/components/returnStatusPanel";

// Which explanation a customer sees when they cannot cancel. Split out from the
// component so the mapping is testable without rendering: a wrong branch here
// tells someone their parcel is in transit when we actually already refunded
// them.

describe("blockedMessageKey", () => {
  it("explains a parcel already with the carrier", () => {
    expect(blockedMessageKey("in-transit")).toBe("blockedInTransit");
  });

  it("explains a return an admin has already settled", () => {
    expect(blockedMessageKey("already-settled")).toBe("blockedSettled");
  });

  it("asks the customer to retry when the carrier is unreachable", () => {
    expect(blockedMessageKey("carrier-unreadable")).toBe("blockedUnreadable");
  });

  it("has no message when there is simply no return", () => {
    // The panel is not rendered at all in this case.
    expect(blockedMessageKey("no-return")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/returnStatusPanel.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 4: Implement the panel**

Create `app/[id]/components/returnStatusPanel.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/context";
import { cancelReturnFunction } from "@/actions/cancelReturn";
import type { CancelBlockedReason, CancelDecision } from "@/lib/cancelEligibility";

/**
 * Which explanation to show for a refusal.
 *
 * Exported and pure so the mapping is testable without rendering. `no-return`
 * has no message because the panel is not rendered at all in that case.
 */
export function blockedMessageKey(
  reason: CancelBlockedReason
): "blockedInTransit" | "blockedSettled" | "blockedUnreadable" | null {
  if (reason === "in-transit") return "blockedInTransit";
  if (reason === "already-settled") return "blockedSettled";
  if (reason === "carrier-unreadable") return "blockedUnreadable";
  return null;
}

type Props = {
  decision: CancelDecision;
  orderId: string;
  locator: string | null;
  carrier: string | null;
};

export function ReturnStatusPanel({ decision, orderId, locator, carrier }: Props) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  const cancel = () => {
    startTransition(async () => {
      const result = await cancelReturnFunction(orderId);
      if (result.ok) {
        setDone(true);
        // The order is now a clean slate; re-read the page so the wizard is
        // usable again rather than showing state that no longer exists.
        window.location.reload();
      } else {
        setFailed(true);
        setConfirming(false);
      }
    });
  };

  const blockedKey = decision.cancellable ? null : blockedMessageKey(decision.reason);

  return (
    <div className="w-full rounded-2xl border border-slate-200 p-4 mb-4 text-sm">
      <h2 className="font-semibold mb-2">{t.cancel.heading}</h2>

      {carrier && (
        <p>
          {t.cancel.carrierLabel}: {carrier}
        </p>
      )}
      {locator && (
        <p className="break-all">
          {t.cancel.trackingLabel}: {locator}
        </p>
      )}

      {done && <p className="mt-3 font-semibold">{t.cancel.doneTitle}</p>}
      {failed && <p className="mt-3">{t.cancel.failed}</p>}
      {blockedKey && <p className="mt-3">{t.cancel[blockedKey]}</p>}

      {decision.cancellable && !done && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 underline"
        >
          {t.cancel.button}
        </button>
      )}

      {confirming && !done && (
        <div className="mt-3">
          <p className="font-semibold">{t.cancel.confirmQuestion}</p>
          <p>{t.cancel.confirmDetail}</p>
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              onClick={cancel}
              disabled={isPending}
              aria-busy={isPending}
              className="bg-black text-white py-2 px-4 rounded-full disabled:opacity-60"
            >
              {isPending ? t.cancel.cancelling : t.cancel.confirmYes}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={isPending}
              className="border border-black py-2 px-4 rounded-full"
            >
              {t.cancel.confirmNo}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/returnStatusPanel.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Wire it into the page**

In `app/[id]/page.tsx`, add the imports:

```ts
import { readCarrierMovement } from "@/actions/shipping";
import { cancelEligibility } from "@/lib/cancelEligibility";
import { ReturnStatusPanel } from "./components/returnStatusPanel";
```

After `const locale = readLocale(...)` and before the `return`:

```ts
  // Computed here for what to SHOW. `cancelReturnFunction` computes it again
  // from its own fresh reads — what this page rendered is a hint, never the
  // authority on what may happen.
  const movement = await readCarrierMovement(orderData.locator);
  const cancelDecision = cancelEligibility(orderData as any, movement);
  const hasReturn = orderData.products.some((line: any) => line?.confirmed === true);
```

Then inside the returned JSX, immediately above `<OrderWindow ... />` in
`clientOrder.tsx`'s parent — that is, pass it through. The simplest wiring that
does not restructure `ClientOrder`: render the panel in `page.tsx` directly
above `<ClientOrder ... />`, inside the existing `<LocaleProvider>` so `useT`
resolves:

```tsx
        {hasReturn && (
          <ReturnStatusPanel
            decision={cancelDecision}
            orderId={params.id}
            locator={orderData.locator ?? null}
            carrier={orderData.carrier ?? null}
          />
        )}
```

- [ ] **Step 7: Verify it builds and renders**

Run: `npx tsc --noEmit && npm run build`
Expected: build succeeds. `next build` is the only thing that typechecks the
JSX end to end.

- [ ] **Step 8: Commit**

```bash
git add lib/i18n/es.ts lib/i18n/en.ts app/[id]/components/returnStatusPanel.tsx "app/[id]/page.tsx" tests/returnStatusPanel.test.ts
git commit -m "feat: show a customer their return, and let them cancel it"
```

---

### Task 8: Verify against production

The suite proves the logic. It cannot prove that Amphora accepts our cancel, that Stripe refunds the intent we stored, or that the panel appears for a real order.

**Files:** none — this task changes no code.

- [ ] **Step 1: Confirm the column exists in production**

The DDL from Task 5 must already be applied. Confirm before deploying:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'orders' AND column_name = 'stripe_payment_intent';
```

Expected: one row. If empty, apply the `ALTER TABLE` from Task 5 Step 1 **before** deploying.

- [ ] **Step 2: Full local gate**

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: no type errors, every test passing, build succeeds.

- [ ] **Step 3: Deploy and watch**

```bash
git push
npx vercel ls --scope <the team the project is linked to> | head
```

Confirm the newest deployment reaches **Ready** and is aliased to the production domain. A deployment that errors before building produces no build logs — check status, not silence.

- [ ] **Step 4: End-to-end on a test order**

Use a real Shopify order of your own (the previous runs used **#38594**). Remember preview shares the production database — there are no test orders, so use one that belongs to you.

1. Look the order up in the portal and submit a return.
2. Confirm the label email arrives and `orders.locator` is set.
3. Reload `/[orderId]`. The panel must show the tracking and a **Cancel** button.
4. Cancel it. The button must show the pending state, then the page reloads to a clean wizard.
5. Verify each reversal actually happened — **not** by trusting the action's return value:
   - Amphora: `GET /returns` no longer lists it.
   - Shopify: the return's status is `CANCELED`.
   - Stripe: a refund exists against the payment intent.
   - Database: `confirmed` false, `return_id` and `locator` null.
6. Confirm the cancellation email arrived, and that it warns the old label is void.

- [ ] **Step 5: Verify the gate actually blocks**

On a second test return, cancel it *after* the parcel shows movement — or simulate by temporarily setting `orders.return_status` to `TRAVELLING` in the database. The panel must show "your parcel is already on its way" and expose no Cancel button, and calling the action directly must return `{ ok: false, reason: "in-transit" }`.

- [ ] **Step 6: Clean up**

Cancel or reset anything the test runs left behind: Shopify returns, Amphora records, database rows. Note that the **Correos pre-registration cannot be cancelled** — a stray test label will simply sit at `Prerregistrado` forever, which is expected and harmless.

- [ ] **Step 7: Commit any fixes and record what was verified**

```bash
git add -A
git commit -m "test: verify cancellation end to end against production"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Eligibility: four blocking signals | 2 |
| Tri-state carrier read, fails closed on unreadable | 1 |
| Reversal order, step 1 fatal | 6 |
| Spain cancels Amphora only; no Correos cancellation | 3, 6 |
| Reset cannot reuse `updateFinalOrder(revert)` | 4 |
| Ops email on failures past step 1 | 6 |
| `stripe_payment_intent` column + hand DDL | 5 |
| Session-list fallback, 90 days, 300 cap | 5 |
| Full refund, idempotency key | 5 |
| Free returns skip the refund | 5, 6 |
| Panel, blocking reasons, confirm step | 7 |
| Eligibility recomputed inside the action | 6 |
| i18n in both dictionaries, email in `orders.locale` | 7, 6 |
| Stale-label warning in the email | 7 |
| Access gate | 6 |

**Known deviation:** the spec sketched `autoPagingEach` returning `false` to stop; the implementation also increments a counter for the 300 cap. Same behaviour, made explicit.

**Type consistency:** `CarrierMovement` (Task 1) is consumed by Tasks 2 and 6. `CancelDecision` / `CancelBlockedReason` (Task 2) are consumed by 6 and 7. `cancelShopifyReturn` / `resetOrderReturn` (Task 4), `refundOrderPayment` + `RefundOutcome` (Task 5), `cancelAmphoraReturn` (Task 3) are all consumed by Task 6 under the names defined here. `t.cancel.*` is referenced in Task 6 and defined in Task 7 — flagged in Task 6 Step 4.
