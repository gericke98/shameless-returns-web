# Self-Booked Returns (`SELF` lane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer decline our label or collection, ship the parcel with their own courier, and tell us the carrier and tracking number afterwards — paying no return-leg fee.

**Architecture:** A third value of `orders.return_method` alongside the two implicit lanes we already have. `SELF` books no carrier: it creates the Shopify return and an *unapproved* Amphora ticket at submit, then approves that ticket with `carrier_data` when the customer comes back with tracking. The fee is a subtraction from the existing `resolveFee` decomposition, not a new pricing path.

**Tech Stack:** Next.js 14 App Router (server actions), Drizzle + Neon Postgres, Vitest, Stripe Checkout, Postmark, Amphora company API.

**Spec:** `docs/superpowers/specs/2026-08-20-self-booked-returns-design.md`

## Global Constraints

- **Migrations are applied by hand, DDL BEFORE deploy.** Drizzle builds an explicit column list from `db/schema.ts` and SELECTs every declared column. Deploying a schema change ahead of its DDL breaks *every* order lookup in the portal, not just this feature.
- **There is no test database.** Preview shares the production `DATABASE_URL`. Every test in this plan is a Vitest unit test with mocked `@/db/drizzle` and mocked `axios`. Do not write a test that touches the real database.
- **`carrier` must never be null on a `SELF` row that has a `locator`.** `tracksWithCorreos(null)` returns `true`, meaning "our own Correos label" — a null carrier would send a foreign tracking number to `localizador.correos.es`.
- **`carrier_number` is write-once at Amphora approve.** Re-approving 422s; cancel-and-recreate returns the OLD number. Every approve path must be guarded by `locator IS NULL`.
- **Amphora spells approved `APROVED`** — one P. That is the wire value.
- **Money is integer cents.** Convert to euros once, last. Never chain arithmetic on `centsToEuros` output.
- **Never invent a carrier status.** Unknown carriers read `sin_informacion`; that is the honest answer, not a gap to fill.
- All customer-facing copy ships in both `es` and `en` (`lib/i18n/es.ts`, `lib/i18n/en.ts`).
- Run `npm test` (602 tests today) and `npx tsc --noEmit` before every commit.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `db/schema.ts` (modify) | Four new `orders` columns. |
| `lib/returnMethods.ts` (create) | Pure: which methods are offered, and validating a claimed one. |
| `lib/selfReturnNudges.ts` (create) | Pure: given a row and "now", which nudge is due. |
| `lib/cancelEligibility.ts` (modify) | The pre-tracking cancellation window. |
| `lib/emails.ts` (modify) | Instructions and reminder templates. |
| `actions/payments.ts` (modify) | Charge the outbound leg only for `SELF`. |
| `actions/selfBookedReturn.ts` (create) | Submit phase: book nothing, create the unapproved ticket, email instructions. |
| `actions/selfBookedTracking.ts` (create) | Capture phase: persist carrier + tracking, approve Amphora. |
| `actions/selfReturnSweep.ts` (create) | Applies the nudge decision; called by the existing cron. |
| `actions/return.ts` (modify) | Third routing branch; persist the method before Stripe. |
| `app/api/webhooks/stripe/route.ts` (modify) | Same third branch on the paid path. |
| `app/api/cron/amphora-sync/route.ts` (modify) | Run the sweep after the existing poll. |
| `app/[id]/…` (modify/create) | Method choice; tracking capture screen. |

---

# Phase 1 — Foundation

**Gate:** the fee is correct for `SELF` and the columns exist, with **no customer-visible change**. Nothing yet offers the option.

## Task 1: Schema and migration

**Files:**
- Modify: `db/schema.ts:14-50`
- Migration: run by hand against Neon `ShamelessReturns`

**Interfaces:**
- Consumes: nothing
- Produces: `orders.returnMethod`, `orders.returnSubmittedAt`, `orders.trackingSubmittedAt`, `orders.trackingNudgeStage` on the Drizzle `orders` table.

- [ ] **Step 1: Apply the DDL to production FIRST**

Get the connection string the app itself uses, then run:

```bash
DB=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
psql "$DB" <<'SQL'
ALTER TABLE orders ADD COLUMN return_method text;
ALTER TABLE orders ADD COLUMN return_submitted_at timestamptz;
ALTER TABLE orders ADD COLUMN tracking_submitted_at timestamptz;
ALTER TABLE orders ADD COLUMN tracking_nudge_stage smallint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD CONSTRAINT orders_self_return_needs_carrier
  CHECK (return_method <> 'SELF' OR locator IS NULL OR carrier IS NOT NULL);
SQL
psql "$DB" -c "\d orders"
```

Expected: the four columns and the constraint appear in `\d orders`.

- [ ] **Step 2: Add the columns to the Drizzle schema**

In `db/schema.ts`, add `smallint` to the existing `drizzle-orm/pg-core` import list, then add inside `pgTable("orders", { … })` after `stripePaymentIntent`:

```ts
  // Which lane shipped this return: 'CORREOS' | 'AMPHORA' | 'SELF'. Null on
  // rows created before self-booking existed, which are inferred by country
  // exactly as they were.
  returnMethod: text("return_method"),
  // When the return was confirmed. `orders` has no other timestamp column, so
  // without this there is nothing to measure the abandonment window against.
  returnSubmittedAt: timestamp("return_submitted_at", { withTimezone: true }),
  // Null while a SELF return is still waiting for the customer's tracking.
  trackingSubmittedAt: timestamp("tracking_submitted_at", { withTimezone: true }),
  // 0 none, 1 reminder sent, 2 ops alerted. A stored fact, so a cron running
  // every 15 minutes cannot re-send by recomputing from age.
  trackingNudgeStage: smallint("tracking_nudge_stage").notNull().default(0),
```

- [ ] **Step 3: Verify nothing regressed**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean, 602 tests pass. (Every order lookup SELECTs these columns now; a failure here means the DDL did not apply.)

- [ ] **Step 4: Commit**

```bash
git add db/schema.ts
git commit -m "feat: columns for the self-booked return lane"
```

## Task 2: `lib/returnMethods.ts` — which methods are offered

**Files:**
- Create: `lib/returnMethods.ts`
- Test: `tests/returnMethods.test.ts`

**Interfaces:**
- Consumes: `isInternationalOrder` from `@/lib/countries`
- Produces:
  - `type ReturnMethod = "CORREOS" | "AMPHORA" | "SELF"`
  - `defaultMethodFor(country: string | null | undefined, amphoraEnabled: boolean): ReturnMethod`
  - `selfBookingOffered(returnLegCents: number): boolean`
  - `resolveReturnMethod(claimed: unknown, country: string | null | undefined, amphoraEnabled: boolean, returnLegCents: number): ReturnMethod`

- [ ] **Step 1: Write the failing test**

Create `tests/returnMethods.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  defaultMethodFor,
  resolveReturnMethod,
  selfBookingOffered,
} from "@/lib/returnMethods";

describe("defaultMethodFor", () => {
  it("routes Spain to Correos", () => {
    expect(defaultMethodFor("Spain", true)).toBe("CORREOS");
  });

  it("routes elsewhere to Amphora when the flag is on", () => {
    expect(defaultMethodFor("Italy", true)).toBe("AMPHORA");
  });

  it("falls back to Correos when the Amphora flag is off", () => {
    // Behaviour-identical to the Correos-only flow, which is what the flag
    // being off has always meant.
    expect(defaultMethodFor("Italy", false)).toBe("CORREOS");
  });
});

describe("selfBookingOffered", () => {
  it("is offered when the return leg costs the customer money", () => {
    expect(selfBookingOffered(650)).toBe(true);
  });

  it("is hidden when our own return leg is free", () => {
    // Self-booking could only cost them more, so offering it would invite
    // people to pay postage they did not need to pay.
    expect(selfBookingOffered(0)).toBe(false);
  });
});

describe("resolveReturnMethod", () => {
  it("honours a valid SELF claim when it is offered", () => {
    expect(resolveReturnMethod("SELF", "Italy", true, 650)).toBe("SELF");
  });

  it("refuses SELF where it is not offered", () => {
    // The amount is never taken from the client; neither is the right to
    // claim a lane that would reduce it.
    expect(resolveReturnMethod("SELF", "Italy", true, 0)).toBe("AMPHORA");
  });

  it("ignores an unknown method rather than trusting it", () => {
    expect(resolveReturnMethod("FREE_PLEASE", "Spain", true, 650)).toBe("CORREOS");
  });

  it("ignores a non-string claim", () => {
    expect(resolveReturnMethod(undefined, "Spain", true, 650)).toBe("CORREOS");
    expect(resolveReturnMethod({ method: "SELF" }, "Spain", true, 650)).toBe("CORREOS");
  });

  it("never lets the client pick our own lanes either", () => {
    // A Spanish order claiming AMPHORA would book a collection we do not
    // offer domestically. Only SELF is the customer's to choose.
    expect(resolveReturnMethod("AMPHORA", "Spain", true, 650)).toBe("CORREOS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/returnMethods.test.ts`
Expected: FAIL — cannot resolve `@/lib/returnMethods`.

- [ ] **Step 3: Write the implementation**

Create `lib/returnMethods.ts`:

```ts
// Pure — no db, no env, no network. Which shipping lanes a return may use, and
// which of them the customer is allowed to pick, so the whole matrix is
// testable without standing up an order or a carrier.

import { isInternationalOrder } from "@/lib/countries";

export type ReturnMethod = "CORREOS" | "AMPHORA" | "SELF";

/**
 * The lane we would choose for this order if the customer expressed no
 * preference — i.e. exactly what `createReturnShipment` did before self-booking
 * existed. Kept identical on purpose: with no SELF claim, behaviour must not
 * change for anybody.
 */
export function defaultMethodFor(
  country: string | null | undefined,
  amphoraEnabled: boolean
): ReturnMethod {
  return isInternationalOrder(country) && amphoraEnabled ? "AMPHORA" : "CORREOS";
}

/**
 * Self-booking is offered only where our own return leg costs the customer
 * something. Where our label is already free it could only cost them more, and
 * it would generate untracked parcels for no benefit.
 */
export function selfBookingOffered(returnLegCents: number): boolean {
  return returnLegCents > 0;
}

/**
 * The lane to actually use, given what the client claimed.
 *
 * SELF is the ONLY method a customer may choose. Everything else is decided by
 * their address, so a claim of "CORREOS" or "AMPHORA" is either noise or an
 * attempt to book a lane we do not run for that country — both are ignored in
 * favour of the default.
 *
 * The fee is re-derived from the RESULT of this function, never from the claim,
 * which is what stops a client asking for SELF on a free return to shed the
 * return leg of an exchange.
 */
export function resolveReturnMethod(
  claimed: unknown,
  country: string | null | undefined,
  amphoraEnabled: boolean,
  returnLegCents: number
): ReturnMethod {
  const fallback = defaultMethodFor(country, amphoraEnabled);
  if (claimed !== "SELF") return fallback;
  return selfBookingOffered(returnLegCents) ? "SELF" : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/returnMethods.test.ts`
Expected: PASS (11 assertions across 4 describes).

- [ ] **Step 5: Commit**

```bash
git add lib/returnMethods.ts tests/returnMethods.test.ts
git commit -m "feat: decide which return lanes an order may use"
```

## Task 3: Charge the outbound leg only for `SELF`

**Files:**
- Modify: `actions/payments.ts:33-60`
- Test: `tests/selfBookedFee.test.ts`

**Interfaces:**
- Consumes: `ReturnMethod` from Task 2; `resolveFee`, `checkoutLines`, `centsToEuros` from `@/lib/fees`
- Produces: `createStripeUrl(id: string, email: string, isCredit: boolean, method: ReturnMethod)` — a fourth positional parameter. All callers must pass it.

- [ ] **Step 1: Write the failing test**

Create `tests/selfBookedFee.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// Self-booking is a SUBTRACTION from the fee we already compute, not a new
// pricing path: resolveFee already splits the charge into the customer's parcel
// coming back and the replacement going out. SELF drops the first and keeps the
// second, because we still ship the replacement on an exchange.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const order = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  shippingCountry: "Italy",
  shippingZip: "20121",
  locale: "es",
};

// Return leg 6.50, exchange (both legs) 11.00 -> outbound leg 4.50.
const BANDS = [
  { maxGrams: 2147483647, returnFeeCents: 650, exchangeFeeCents: 1100 },
];

const basket = { hasItems: true, netAmount: 0, grams: 500 };
const sessions: any[] = [];

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));
vi.mock("@/db/fees", () => ({ getFeeTable: async () => ({ "*": BANDS }) }));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: async () => ({ order, discountedProducts: [], basket }),
}));
vi.mock("@/lib/stripe", () => ({
  stripe: {
    checkout: {
      sessions: {
        create: async (args: any) => {
          sessions.push(args);
          return { url: "https://stripe.test/session" };
        },
      },
    },
  },
}));

async function priceIt(method: "AMPHORA" | "SELF") {
  const { createStripeUrl } = await import("@/actions/payments");
  return createStripeUrl(order.id, order.email, false, method);
}

/** What Stripe was actually asked to charge, in cents. */
function chargedCents(): number {
  const last = sessions[sessions.length - 1];
  return last.line_items.reduce(
    (sum: number, li: any) => sum + li.price_data.unit_amount * li.quantity,
    0
  );
}

beforeEach(() => {
  sessions.length = 0;
  basket.netAmount = 0;
  process.env.NEXT_PUBLIC_APP_URL = "https://returns.test";
});

describe("SELF drops the return leg", () => {
  it("charges an exchange the outbound leg only", async () => {
    // netAmount 0 -> exchange. Our lane charges 11.00; SELF charges 4.50.
    await priceIt("SELF");

    expect(chargedCents()).toBe(450);
  });

  it("still charges our own lane both legs", async () => {
    await priceIt("AMPHORA");

    expect(chargedCents()).toBe(1100);
  });

  it("charges a pure return nothing at all", async () => {
    // The customer is owed money and pays their own postage, so there is
    // nothing to collect and no Stripe session should exist.
    basket.netAmount = 52.5;

    const result = await priceIt("SELF");

    expect(result.data).toBeNull();
    expect(sessions).toHaveLength(0);
  });

  it("itemises the charge as delivery, never as return shipping", async () => {
    // The customer is paying their own courier for the return leg; billing
    // them a line that says otherwise is the complaint.
    await priceIt("SELF");

    const names = sessions[0].line_items.map((li: any) => li.price_data.product_data.name);
    expect(names).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selfBookedFee.test.ts`
Expected: FAIL — `createStripeUrl` takes three parameters, so `method` is ignored and the exchange is charged 1100 instead of 450.

- [ ] **Step 3: Write the implementation**

In `actions/payments.ts`, add the import:

```ts
import type { ReturnMethod } from "@/lib/returnMethods";
```

Change the signature and the amount derivation. Replace:

```ts
export const createStripeUrl = async (
  id: string,
  email: string,
  isCredit: boolean
) => {
```

with:

```ts
export const createStripeUrl = async (
  id: string,
  email: string,
  isCredit: boolean,
  method: ReturnMethod
) => {
```

Then, immediately after the existing `const { feeCents, returnLegCents, outboundLegCents } = resolveFee(fees, basket);` line, insert:

```ts
  // A self-booked return pays its own courier, so we bill the outbound leg
  // alone — the replacement garment still travels on our account. This is the
  // whole of the SELF pricing rule: a subtraction, not a second fee table.
  //
  // `method` has already been through resolveReturnMethod on the server, so it
  // cannot be a client claiming SELF where SELF is not offered.
  const selfBooked = method === "SELF";
  const chargeReturnLegCents = selfBooked ? 0 : returnLegCents;
  const chargeCents = selfBooked ? outboundLegCents : feeCents;
```

Replace the `totalEuros` line:

```ts
  const totalEuros = basket.netAmount - centsToEuros(chargeCents);
```

Replace the `checkoutLines` call:

```ts
  const lines = checkoutLines(
    basket,
    { returnLegCents: chargeReturnLegCents, outboundLegCents },
    amountCents
  );
```

- [ ] **Step 4: Fix the two existing callers so the build stays green**

`actions/return.ts` and `app/api/webhooks/stripe/route.ts` both call `createStripeUrl`. Task 7 wires the real method through; for now pass the default so behaviour is unchanged:

In `actions/return.ts`, replace `await createStripeUrl(id, email, isCredit)` with:

```ts
  await createStripeUrl(id, email, isCredit, defaultMethodFor(order?.shippingCountry, process.env.AMPHORA_INTL_RETURNS_ENABLED === "true"))
```

adding `import { defaultMethodFor } from "@/lib/returnMethods";` and loading `const order = await getOrderById(id);` above it if not already in scope.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/selfBookedFee.test.ts && npm test && npx tsc --noEmit`
Expected: new test PASSES, 602 existing tests still pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add actions/payments.ts actions/return.ts tests/selfBookedFee.test.ts
git commit -m "feat: a self-booked return pays only for the outbound leg"
```

---

# Phase 2 — The server lane

**Gate:** a `SELF` return can be driven end to end — submit, then tracking capture — from tests alone, with no UI. Amphora is `PENDING` after submit and `APROVED` with the customer's carrier after capture.

## Task 4: Email templates

**Files:**
- Modify: `lib/emails.ts`, `lib/i18n/es.ts`, `lib/i18n/en.ts`
- Test: `tests/selfReturnEmails.test.ts`

**Interfaces:**
- Consumes: the `EmailPayload` shape and `FROM` constant already in `lib/emails.ts`
- Produces:
  - `buildSelfReturnInstructionsEmail(name: string, locale: Locale, orderId: string): EmailPayload`
  - `buildSelfReturnReminderEmail(name: string, locale: Locale, orderId: string): EmailPayload`
  - `sendSelfReturnInstructions(to: string, name: string, locale: Locale, orderId: string): Promise<number>`
  - `sendSelfReturnReminder(to: string, name: string, locale: Locale, orderId: string): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `tests/selfReturnEmails.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildSelfReturnInstructionsEmail,
  buildSelfReturnReminderEmail,
} from "@/lib/emails";

const WAREHOUSE = "Calle Pelaya 25";

describe("self-booked return instructions", () => {
  it("gives the customer the warehouse address", () => {
    // Without this they have nowhere to send the parcel, which is the one
    // thing this lane must supply.
    const mail = buildSelfReturnInstructionsEmail("Ferran", "es", "132210");

    expect(mail.HtmlBody).toContain(WAREHOUSE);
  });

  it("links back to the portal so they can submit tracking", () => {
    const mail = buildSelfReturnInstructionsEmail("Ferran", "es", "132210");

    expect(mail.HtmlBody).toContain("132210");
  });

  it("warns about customs when shipping from outside the EU", () => {
    // The one support burden this lane invites that the other two do not: the
    // customer arranges their own paperwork, and a parcel held at the border
    // costs them money we cannot refund.
    const mail = buildSelfReturnInstructionsEmail("Ferran", "en", "132210");

    expect(mail.HtmlBody.toLowerCase()).toContain("customs");
  });

  it("never claims a label is attached", () => {
    // There is no label. The Correos template says one is attached, and
    // reusing its copy here would be a lie.
    const mail = buildSelfReturnInstructionsEmail("Ferran", "es", "132210");

    expect(mail.HtmlBody.toLowerCase()).not.toContain("etiqueta adjunta");
  });

  it("ships in both languages", () => {
    const es = buildSelfReturnInstructionsEmail("Ferran", "es", "132210");
    const en = buildSelfReturnInstructionsEmail("Ferran", "en", "132210");

    expect(es.Subject).not.toBe(en.Subject);
  });
});

describe("self-booked return reminder", () => {
  it("asks for the tracking number", () => {
    const mail = buildSelfReturnReminderEmail("Ferran", "es", "132210");

    expect(mail.Subject.length).toBeGreaterThan(0);
    expect(mail.HtmlBody).toContain("132210");
  });

  it("is a different message from the instructions", () => {
    const first = buildSelfReturnInstructionsEmail("Ferran", "es", "132210");
    const nudge = buildSelfReturnReminderEmail("Ferran", "es", "132210");

    expect(nudge.Subject).not.toBe(first.Subject);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selfReturnEmails.test.ts`
Expected: FAIL — `buildSelfReturnInstructionsEmail` is not exported from `@/lib/emails`.

- [ ] **Step 3: Write the implementation**

In `lib/emails.ts`, follow the existing `CORREOS_COPY` / `buildCorreosEmail` pattern exactly. Add:

```ts
/* -------------------------------------------------------------------------- */
/* Self-booked — the customer arranges their own courier                      */
/* -------------------------------------------------------------------------- */

/** Where the customer posts the parcel. Same warehouse the Correos label is
 *  addressed to — see generateSoapBody in actions/shipping.ts. */
const WAREHOUSE_ADDRESS = [
  "Shameless Collective (Amphora Logistics)",
  "Calle Pelaya 25, Poligono Industrial Rio de Janeiro",
  "28110 Algete, Madrid",
  "España",
].join("<br/>");

const SELF_COPY = {
  es: {
    subject: "Tu devolución: envíala cuando quieras",
    reminderSubject: "¿Ya has enviado tu devolución?",
    text: "Tu devolución se ha creado. Envíala con el transportista que prefieras.",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Has elegido enviar tu devolución por tu cuenta, así que <strong>no adjuntamos ninguna etiqueta</strong> — el envío lo organizas tú, con el transportista que prefieras.",
    stepsTitle: "Pasos para completar tu devolución:",
    steps: [
      "Empaqueta los artículos en su envoltorio original.",
      "Escribe tu número de pedido en el exterior del paquete.",
      "Envíalo a la dirección de abajo con el transportista que elijas.",
      "Vuelve al portal y dinos el transportista y el número de seguimiento.",
    ],
    addressTitle: "Dirección de envío:",
    trackingCta: "Enviar mi número de seguimiento",
    trackingWhy:
      "Sin el número de seguimiento no podemos avisar al almacén de que tu paquete está en camino, y tu reembolso puede retrasarse.",
    customs:
      "<strong>Si envías desde fuera de la Unión Europea</strong>, el paquete pasará por aduanas y la documentación corre de tu cuenta. Un envío mal declarado puede quedarse retenido o devolverse, y esos gastos no los podemos cubrir.",
    reminderIntro:
      "Hace unos días creaste una devolución para enviarla por tu cuenta y todavía no nos has dicho el número de seguimiento.",
    contact: "Si tienes alguna pregunta, no dudes en contactarnos en",
    signoff:
      "Saludos cordiales,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "Your return: send it whenever you like",
    reminderSubject: "Have you sent your return yet?",
    text: "Your return has been created. Send it with any carrier you like.",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "You chose to ship your return yourself, so <strong>there is no label attached</strong> — you arrange the shipment, with whichever carrier you prefer.",
    stepsTitle: "Steps to complete your return:",
    steps: [
      "Pack the items in their original wrapping.",
      "Write your order number on the outside of the parcel.",
      "Send it to the address below with the carrier of your choice.",
      "Come back to the portal and tell us the carrier and tracking number.",
    ],
    addressTitle: "Shipping address:",
    trackingCta: "Send us my tracking number",
    trackingWhy:
      "Without the tracking number we cannot tell the warehouse your parcel is on its way, and your refund may be delayed.",
    customs:
      "<strong>If you are shipping from outside the European Union</strong>, the parcel will pass through customs and the paperwork is yours to arrange. A badly declared shipment can be held or returned, and we cannot cover those costs.",
    reminderIntro:
      "A few days ago you created a return to ship yourself, and we still do not have a tracking number for it.",
    contact: "If you have any questions, contact us at",
    signoff: "Best regards,<br/><strong>The Shameless Collective team</strong>",
  },
} as const;

function selfReturnLink(orderId: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/${orderId}`;
}

function selfReturnShell(
  c: (typeof SELF_COPY)["es"],
  name: string,
  orderId: string,
  intro: string
): string {
  const p = 'style="font-size: 16px; color: #555;"';
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 20px auto;">
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="cid:embedded-image" alt="Shameless Collective Logo" style="max-width: 400px; height: auto;"/>
      </div>
      <div>
        <p ${p}>${c.greeting(name)}</p>
        <p ${p}>${intro}</p>
        <p ${p}>${c.stepsTitle}</p>
        <ol style="font-size: 16px; color: #555; margin-left: 20px; padding-left: 10px;">
          ${c.steps.map((s) => `<li style="margin-bottom: 10px;">${s}</li>`).join("")}
        </ol>
        <p ${p}><strong>${c.addressTitle}</strong><br/>${WAREHOUSE_ADDRESS}</p>
        <p ${p}>
          <a href="${selfReturnLink(orderId)}" style="color: #0073e6;">${c.trackingCta}</a>
        </p>
        <p ${p}>${c.trackingWhy}</p>
        <p ${p}>${c.customs}</p>
        <p ${p}>${c.contact}
          <a href="mailto:${FROM}" style="color: #0073e6; text-decoration: none;">${FROM}</a>.
        </p>
        <p ${p}>${c.signoff}</p>
      </div>
    </div>
  `;
}

export function buildSelfReturnInstructionsEmail(
  name: string,
  locale: Locale,
  orderId: string
): EmailPayload {
  const c = SELF_COPY[locale];
  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.text,
    HtmlBody: selfReturnShell(c, name, orderId, c.intro),
  };
}

export function buildSelfReturnReminderEmail(
  name: string,
  locale: Locale,
  orderId: string
): EmailPayload {
  const c = SELF_COPY[locale];
  return {
    From: FROM,
    To: "",
    Subject: c.reminderSubject,
    TextBody: c.reminderIntro,
    HtmlBody: selfReturnShell(c, name, orderId, c.reminderIntro),
  };
}
```

Then add the two senders, following the `sendEmail` pattern already in `actions/shipping.ts` (Postmark POST, `MessageStream: "outbound"`, the `mail.jpg` inline image with `ContentID: "embedded-image"`, and **no** PDF attachment):

```ts
async function sendSelfReturnEmail(
  payload: EmailPayload,
  to: string
): Promise<number> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return 500;
  try {
    const res = await axios.post(
      "https://api.postmarkapp.com/email",
      {
        ...payload,
        To: to,
        MessageStream: "outbound",
        Attachments: [
          {
            Name: "mail.jpg",
            Content: base64img,
            ContentType: "image/jpeg",
            ContentID: "embedded-image",
          },
        ],
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
      }
    );
    return res.status;
  } catch (error: any) {
    console.error(
      "Self-return email error:",
      error?.response?.data || error?.message || error
    );
    return 500;
  }
}

export async function sendSelfReturnInstructions(
  to: string,
  name: string,
  locale: Locale,
  orderId: string
): Promise<number> {
  return sendSelfReturnEmail(
    buildSelfReturnInstructionsEmail(name, locale, orderId),
    to
  );
}

export async function sendSelfReturnReminder(
  to: string,
  name: string,
  locale: Locale,
  orderId: string
): Promise<number> {
  return sendSelfReturnEmail(
    buildSelfReturnReminderEmail(name, locale, orderId),
    to
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/selfReturnEmails.test.ts tests/selfBookedReturn.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/emails.ts tests/selfReturnEmails.test.ts
git commit -m "feat: instructions and reminder emails for self-booked returns"
```

## Task 5: `createSelfBookedReturn` — submit books nothing

**Files:**
- Create: `actions/selfBookedReturn.ts`
- Test: `tests/selfBookedReturn.test.ts`

**Interfaces:**
- Consumes: `getOrderById` from `@/db/queries`; `createAmphoraReturn`, `amphoraOrderIdFromShopifyId` from `@/actions/amphora`; `getVariantSkusByIds` from `@/db/queries`; `sendSelfReturnInstructions` from `@/lib/emails` (Task 4); `alertOps` from `@/actions/opsAlert`
- Produces: `createSelfBookedReturn(id: string): Promise<number>` — HTTP-style status, 200 on success, mirroring `createShippingLabel` and `createInternationalReturn`.

- [ ] **Step 1: Write the failing test**

Create `tests/selfBookedReturn.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// The submit half of a self-booked return. It must book NOTHING: no Correos
// pre-registration, no Amphora collection, no courier. The Amphora ticket is
// created unapproved on purpose — approving it is what dispatches a courier,
// and approve also PINS carrier_number write-once, which we cannot fill in
// until the customer has actually been to the post office.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  shippingName: "Ferran Palma",
  shippingCountry: "Italy",
  locale: "es",
  locator: null,
  products: [{ variant_id: "1", quantity: 1, action: "DEVOLUCIÓN" }],
};

const created: any[] = [];
const approved: any[] = [];
const emails: any[] = [];
const alerts: any[] = [];
const written: any[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getVariantSkusByIds: async () => ({ "1": "SKU-1" }),
}));

vi.mock("@/actions/amphora", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createAmphoraReturn: async (input: any) => {
      created.push(input);
      return { id: "SHP 13221047697734", internal_status: "PENDING" };
    },
    approveAmphoraReturn: async (id: string, data: any) => {
      approved.push({ id, data });
      return { id, internal_status: "APROVED" };
    },
  };
});

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      written.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) {
        emails.push(url);
        return { status: 200 };
      }
      throw new Error(`unexpected outbound call to ${url}`);
    },
  },
}));

async function run() {
  const { createSelfBookedReturn } = await import("@/actions/selfBookedReturn");
  return createSelfBookedReturn(ORDER.id);
}

beforeEach(() => {
  created.length = 0;
  approved.length = 0;
  emails.length = 0;
  alerts.length = 0;
  written.length = 0;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("createSelfBookedReturn", () => {
  it("reports success", async () => {
    await expect(run()).resolves.toBe(200);
  });

  it("creates the Amphora ticket without auto-approving it", async () => {
    // auto_approve is what dispatches a courier. There is no parcel to collect
    // — the customer is posting it themselves.
    await run();

    expect(created).toHaveLength(1);
    expect(created[0].autoApprove).toBeFalsy();
  });

  it("never approves the ticket at submit time", async () => {
    // carrier_number is write-once at approve, and we do not know it yet.
    await run();

    expect(approved).toHaveLength(0);
  });

  it("books no carrier of our own", async () => {
    // No Correos SOAP call: the axios mock throws on anything but Postmark.
    await expect(run()).resolves.toBe(200);
  });

  it("stamps when the return was submitted", async () => {
    // orders has no other timestamp, and the abandonment sweep measures from
    // this one.
    await run();

    const stamped = written.find((w) => w.returnSubmittedAt);
    expect(stamped?.returnSubmittedAt).toBeInstanceOf(Date);
  });

  it("emails the customer their instructions", async () => {
    await run();

    expect(emails).toHaveLength(1);
  });

  it("alerts a human when the warehouse could not be told", async () => {
    // Same rule as every other lane: the return still exists, so we swallow
    // and report 200 — but never silently. #311174 is why.
    created.length = 0;
    const amphora = await import("@/actions/amphora");
    vi.spyOn(amphora, "createAmphoraReturn").mockRejectedValueOnce(
      new Error("amphora 503")
    );

    await expect(run()).resolves.toBe(200);
    expect(alerts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selfBookedReturn.test.ts`
Expected: FAIL — cannot resolve `@/actions/selfBookedReturn`.

- [ ] **Step 3: Write the implementation**

Create `actions/selfBookedReturn.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getOrderById, getVariantSkusByIds } from "@/db/queries";
import {
  amphoraOrderIdFromShopifyId,
  createAmphoraReturn,
} from "./amphora";
import { alertOps } from "./opsAlert";
import { sendSelfReturnInstructions } from "@/lib/emails";
import { readLocale } from "@/lib/i18n";

/**
 * The submit half of a self-booked return.
 *
 * Books nothing. The customer is arranging their own courier, so there is no
 * Correos pre-registration and no Amphora collection — only a record that a
 * parcel is coming, and instructions telling them where to send it.
 *
 * The Amphora ticket is created WITHOUT `auto_approve` and deliberately left at
 * PENDING. Approving is what dispatches a courier, and it also pins
 * `carrier_number` write-once — we cannot fill that in until the customer has
 * been to the post office. `submitReturnTracking` approves it later.
 *
 * Returns an HTTP-style status to mirror `createShippingLabel` and
 * `createInternationalReturn`, so `createReturnShipment` can treat all three
 * lanes identically.
 */
export async function createSelfBookedReturn(id: string): Promise<number> {
  const order = await getOrderById(id);
  if (!order) return 404;

  // Idempotency, the same guard the other two lanes apply: a resubmit must not
  // open a second warehouse ticket for one parcel.
  if ((order as any).returnSubmittedAt) {
    console.warn(
      `Order ${id}: self-booked return already submitted — skipping (duplicate submit).`
    );
    return 200;
  }

  await db
    .update(orders)
    .set({ returnMethod: "SELF", returnSubmittedAt: new Date() })
    .where(eq(orders.id, id));

  // Everything past this point is best-effort and must not fail the return:
  // the customer's return exists the moment the row above is written, and
  // reporting failure would revert a live Shopify return. Swallowed, but never
  // silently — order #311174 is the standing lesson.
  try {
    const returned = ((order as any).products ?? []).filter(
      (p: any) => p.action !== "CAMBIO" || p.new_variant_id
    );
    const skusById = await getVariantSkusByIds(
      returned.map((p: any) => String(p.variant_id))
    );
    const items = returned
      .map((p: any) => ({
        sku: skusById[String(p.variant_id)],
        quantity: Number(p.quantity) || 1,
      }))
      .filter((i: any) => i.sku);

    if (items.length === 0) {
      throw new Error("no SKUs resolved for the returned lines");
    }

    await createAmphoraReturn({
      orderId: amphoraOrderIdFromShopifyId(order.id),
      items,
      externalId: order.id,
      time: new Date().toISOString(),
      name: order.orderNumber,
      customerEmail: order.email,
      // NOT auto-approved, and NOT approved below. See above.
    });
  } catch (error: any) {
    await alertOps(
      `[returns] SELF RETURN NOT PRE-REGISTERED — ${order.orderNumber}`,
      [
        `A customer is posting a parcel the warehouse does not know about.`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        `Country:   ${order.shippingCountry}`,
        ``,
        `Failure:   ${error?.response?.data || error?.message || error}`,
        ``,
        `The customer's return is fine and they have been sent instructions.`,
        `Open the Amphora ticket by hand (EXTERNAL, no auto_approve) so the`,
        `parcel is expected on arrival.`,
      ].join("\n")
    );
  }

  const emailStatus = await sendSelfReturnInstructions(
    order.email,
    order.shippingName,
    readLocale(order.locale),
    order.id
  );
  if (emailStatus !== 200) {
    await alertOps(
      `[returns] SELF RETURN, NO INSTRUCTIONS — ${order.orderNumber}`,
      [
        `A self-booked return was created and the customer was not told where`,
        `to send the parcel.`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        ``,
        `They chose to ship it themselves and now have no address and no link`,
        `to submit tracking. Send them the instructions by hand.`,
      ].join("\n")
    );
  }

  return 200;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/selfBookedReturn.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add actions/selfBookedReturn.ts tests/selfBookedReturn.test.ts
git commit -m "feat: create a self-booked return without booking a carrier"
```

## Task 6: `submitReturnTracking` — capture and approve

**Files:**
- Create: `actions/selfBookedTracking.ts`
- Create: `lib/carriers.ts`
- Test: `tests/selfBookedTracking.test.ts`

**Interfaces:**
- Consumes: `hasOrderAccess` from `@/lib/orderAccess`; `approveAmphoraReturn`, `amphoraOrderIdFromShopifyId` from `@/actions/amphora`
- Produces:
  - `lib/carriers.ts`: `type CarrierOption = { code: string; label: string; trackingUrl: (n: string) => string }`, `CARRIERS: readonly CarrierOption[]`, `carrierByCode(code: string): CarrierOption | null`
  - `actions/selfBookedTracking.ts`: `submitReturnTracking(id: string, carrierCode: string, trackingNumber: string): Promise<{ ok: boolean; reason?: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/selfBookedTracking.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// The capture half. Two guards carry the weight here:
//
// 1. carrier_number is WRITE-ONCE at Amphora approve. Re-approving 422s and
//    cancel+recreate returns the OLD number, so a second submit must never
//    reach approve.
// 2. `carrier` must never be null on a row that has a locator:
//    tracksWithCorreos(null) === true means "our own Correos label", so a null
//    carrier would send a DHL number to localizador.correos.es.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const order: Record<string, any> = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  returnMethod: "SELF",
  locator: null,
  carrier: null,
};

const approved: any[] = [];
const written: any[] = [];
let access = true;

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => access }));

vi.mock("@/db/queries", () => ({
  getOrderByIdFresh: async () => order,
  getOrderById: async () => order,
}));

vi.mock("@/actions/amphora", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    approveAmphoraReturn: async (id: string, data: any) => {
      approved.push({ id, data });
      return { id, internal_status: "APROVED" };
    },
  };
});

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      written.push(values);
      Object.assign(order, values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

async function submit(carrier = "DHL", number = "JD0123456789") {
  const { submitReturnTracking } = await import("@/actions/selfBookedTracking");
  return submitReturnTracking(order.id, carrier, number);
}

beforeEach(() => {
  approved.length = 0;
  written.length = 0;
  access = true;
  order.locator = null;
  order.carrier = null;
  order.returnMethod = "SELF";
});

describe("submitReturnTracking", () => {
  it("stores the carrier and tracking number", async () => {
    await expect(submit()).resolves.toEqual({ ok: true });

    expect(order.locator).toBe("JD0123456789");
    expect(order.carrier).toBe("DHL");
  });

  it("never leaves the carrier null once a locator exists", async () => {
    await submit();

    expect(order.locator).not.toBeNull();
    expect(order.carrier).not.toBeNull();
  });

  it("stores a tracking URL the customer can actually open", async () => {
    await submit();

    expect(String(order.carrierUrl)).toContain("JD0123456789");
  });

  it("approves Amphora with the customer's carrier data", async () => {
    await submit();

    expect(approved).toHaveLength(1);
    expect(approved[0].data).toEqual({
      carrier: "DHL",
      carrier_number: "JD0123456789",
      carrier_url: expect.stringContaining("JD0123456789"),
    });
  });

  it("refuses a second submit rather than re-approving", async () => {
    // carrier_number is pinned at the first approve. A second attempt 422s and
    // cancel+recreate hands back the OLD number, desyncing the warehouse
    // forever, so this must stop before it reaches Amphora.
    await submit();
    approved.length = 0;

    const second = await submit("UPS", "1Z999");

    expect(second.ok).toBe(false);
    expect(approved).toHaveLength(0);
    expect(order.locator).toBe("JD0123456789");
  });

  it("rejects a caller with no portal session", async () => {
    access = false;

    const result = await submit();

    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("rejects an unknown carrier rather than storing free text", async () => {
    const result = await submit("Correos de mi primo", "X1");

    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("rejects an empty tracking number", async () => {
    const result = await submit("DHL", "   ");

    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("refuses an order that is not a self-booked return", async () => {
    order.returnMethod = "CORREOS";

    const result = await submit();

    expect(result.ok).toBe(false);
    expect(approved).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selfBookedTracking.test.ts`
Expected: FAIL — cannot resolve `@/actions/selfBookedTracking`.

- [ ] **Step 3: Write `lib/carriers.ts`**

```ts
// Pure — the carriers a customer may pick when shipping a return themselves.
//
// A fixed list rather than free text, for two reasons: it gives us a real
// tracking URL to store, and it gives `tracksWithCorreos` a value it can reason
// about. "corros" in the warehouse's records helps nobody.

export type CarrierOption = {
  /** Stored in orders.carrier and sent to Amphora as carrier_data.carrier. */
  readonly code: string;
  readonly label: string;
  readonly trackingUrl: (trackingNumber: string) => string;
};

export const CARRIERS: readonly CarrierOption[] = Object.freeze([
  {
    code: "CORREOS",
    label: "Correos",
    // Picking Correos is legitimate and works: tracksWithCorreos matches this
    // code, so the dashboard shows real phases exactly as it does for a label
    // we booked ourselves.
    trackingUrl: (n) =>
      `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${encodeURIComponent(n)}`,
  },
  {
    code: "SEUR",
    label: "SEUR",
    trackingUrl: (n) => `https://www.seur.com/livetracking/?segOnlineIdentificador=${encodeURIComponent(n)}`,
  },
  {
    code: "MRW",
    label: "MRW",
    trackingUrl: (n) => `https://www.mrw.es/seguimiento_envios/MRW_seguimiento_envios.asp?modo=nacional&envio=${encodeURIComponent(n)}`,
  },
  {
    code: "GLS",
    label: "GLS",
    trackingUrl: (n) => `https://www.gls-spain.es/es/tracking/?match=${encodeURIComponent(n)}`,
  },
  {
    code: "DHL",
    label: "DHL",
    trackingUrl: (n) => `https://www.dhl.com/es-es/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  },
  {
    code: "UPS",
    label: "UPS",
    trackingUrl: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  },
  {
    code: "FEDEX",
    label: "FedEx",
    trackingUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  },
  {
    code: "CTT",
    label: "CTT",
    trackingUrl: (n) => `https://www.ctt.pt/particulares/seguimento?objectSearchInput=${encodeURIComponent(n)}`,
  },
  {
    code: "ANPOST",
    label: "An Post",
    trackingUrl: (n) => `https://www.anpost.com/Post-Parcels/Track?item=${encodeURIComponent(n)}`,
  },
  {
    code: "OTHER",
    label: "Other",
    // No URL we can build. The dashboard will read `sin_informacion`, which is
    // the honest answer — never invent a status.
    trackingUrl: () => "",
  },
]);

export function carrierByCode(code: string): CarrierOption | null {
  return CARRIERS.find((c) => c.code === code) ?? null;
}
```

- [ ] **Step 4: Write `actions/selfBookedTracking.ts`**

```ts
"use server";

import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getOrderByIdFresh } from "@/db/queries";
import { hasOrderAccess } from "@/lib/orderAccess";
import { carrierByCode } from "@/lib/carriers";
import { amphoraOrderIdFromShopifyId, approveAmphoraReturn } from "./amphora";
import { alertOps } from "./opsAlert";

export type TrackingSubmission = { ok: boolean; reason?: string };

/**
 * The capture half of a self-booked return: the customer tells us who they
 * shipped with and the tracking number, and we tell the warehouse.
 *
 * Session-gated, unlike `createShippingLabel`: this one is only ever reached
 * from the portal by the customer, never from a webhook, so there is no paid
 * flow to break by requiring a session.
 *
 * ⚠️ Deliberately NOT `getOrderById` — that is wrapped in React `cache()` and
 * would serve a stale row to a second submit arriving in the same request,
 * defeating the idempotency guard below.
 */
export async function submitReturnTracking(
  id: string,
  carrierCode: string,
  trackingNumber: string
): Promise<TrackingSubmission> {
  if (!(await hasOrderAccess(id))) {
    console.error(`submitReturnTracking: rejected a call without a session for ${id}`);
    return { ok: false, reason: "no-session" };
  }

  const carrier = carrierByCode(carrierCode);
  if (!carrier) return { ok: false, reason: "unknown-carrier" };

  const number = String(trackingNumber ?? "").trim();
  if (!number) return { ok: false, reason: "empty-tracking" };

  const order = await getOrderByIdFresh(id);
  if (!order) return { ok: false, reason: "no-order" };
  if ((order as any).returnMethod !== "SELF") {
    return { ok: false, reason: "not-self-booked" };
  }

  // Idempotency, and the reason it matters more here than anywhere else:
  // Amphora pins `carrier_number` at approve. Re-approving 422s, and
  // cancel-and-recreate hands back the OLD number — so a second submit would
  // desync the warehouse permanently. Stop before Amphora, not after.
  if (order.locator) {
    console.warn(
      `Order ${id}: tracking ${order.locator} already submitted — refusing to replace it.`
    );
    return { ok: false, reason: "already-submitted" };
  }

  const carrierUrl = carrier.trackingUrl(number);

  // Written together, and BEFORE Amphora: `carrier` must never be null on a row
  // that has a locator, or `tracksWithCorreos` reads the null as "our own
  // Correos label" and sends a foreign tracking number to localizador.correos.es.
  // The check constraint enforces the same thing at the database.
  await db
    .update(orders)
    .set({
      locator: number,
      carrier: carrier.code,
      carrierUrl,
      trackingSubmittedAt: new Date(),
    })
    .where(eq(orders.id, id));

  // Best-effort, and swallowed: the customer has done everything asked of them
  // and the parcel is already moving. Never silent, though.
  try {
    await approveAmphoraReturn(amphoraOrderIdFromShopifyId(id), {
      carrier: carrier.code,
      carrier_number: number,
      carrier_url: carrierUrl,
    });
  } catch (error: any) {
    await alertOps(
      `[returns] SELF RETURN NOT APPROVED — ${order.orderNumber}`,
      [
        `A customer submitted tracking and the warehouse was not told.`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        `Carrier:   ${carrier.code}`,
        `Tracking:  ${number}`,
        ``,
        `Failure:   ${error?.response?.data || error?.message || error}`,
        ``,
        `We hold the tracking; Amphora does not. Approve the ticket by hand`,
        `with this carrier data. Note carrier_number is write-once, so get it`,
        `right the first time.`,
      ].join("\n")
    );
  }

  return { ok: true };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/selfBookedTracking.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/carriers.ts actions/selfBookedTracking.ts tests/selfBookedTracking.test.ts
git commit -m "feat: capture the customer's carrier and tracking, and tell the warehouse"
```

## Task 7: Route `SELF` through both submit paths

**Files:**
- Modify: `actions/return.ts` (`createReturnShipment`, `returnFunction`)
- Modify: `app/api/webhooks/stripe/route.ts:127-142`
- Test: `tests/selfBookedRouting.test.ts`

**Interfaces:**
- Consumes: `createSelfBookedReturn` (Task 5), `resolveReturnMethod` / `defaultMethodFor` (Task 2), `createStripeUrl` with its fourth parameter (Task 3)
- Produces: `returnFunction(id: string, isCredit: boolean, email: string, method?: unknown)` — a fourth optional parameter carrying the client's claim.

- [ ] **Step 1: Write the failing test**

Create `tests/selfBookedRouting.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// The chosen lane must survive the Stripe round trip. returnFunction redirects
// to Stripe for a paid return and comes back through the webhook, which has no
// session and no client state — so the method has to be ON THE ORDER ROW before
// the redirect, exactly as persistOrderLocale already does for the language.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const REDIRECTED = "NEXT_REDIRECT";

const order: Record<string, any> = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  shippingCountry: "Italy",
  shippingZip: "20121",
  locale: "es",
  locator: null,
  returnMethod: null,
  products: [{ variant_id: "1", quantity: 1, action: "DEVOLUCIÓN" }],
};

const calls = { self: 0, correos: 0, amphora: 0 };
const written: any[] = [];
let stripeUrl: string | null = null;
let stripeMethodSeen: string | null = null;

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(REDIRECTED), { to });
  },
}));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => ({ name: "locale", value: "es" }) }),
}));
vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));
vi.mock("@/actions/updateOrder", () => ({ updateFinalOrder: async () => {} }));
vi.mock("@/actions/opsAlert", () => ({ alertOps: async () => {} }));

vi.mock("@/actions/payments", () => ({
  createStripeUrl: async (_id: string, _e: string, _c: boolean, method: string) => {
    stripeMethodSeen = method;
    return { data: stripeUrl };
  },
}));

vi.mock("@/actions/selfBookedReturn", () => ({
  createSelfBookedReturn: async () => {
    calls.self += 1;
    return 200;
  },
}));
vi.mock("@/actions/shipping", () => ({
  createShippingLabel: async () => {
    calls.correos += 1;
    return 200;
  },
}));
vi.mock("@/actions/amphoraReturn", () => ({
  createInternationalReturn: async () => {
    calls.amphora += 1;
    return 200;
  },
  isInternationalOrder: (c: string) => String(c).toLowerCase() !== "spain",
}));

vi.mock("@/db/queries", () => ({
  getOrderById: async () => order,
  getOrderByIdFresh: async () => order,
}));

vi.mock("@/db/fees", () => ({
  getFeeTable: async () => ({
    "*": [{ maxGrams: 2147483647, returnFeeCents: 650, exchangeFeeCents: 1100 }],
  }),
}));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: async () => ({
    order,
    discountedProducts: [],
    basket: { hasItems: true, netAmount: 52.5, grams: 500 },
  }),
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      written.push(values);
      Object.assign(order, values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

async function submit(method?: unknown) {
  const { returnFunction } = await import("@/actions/return");
  try {
    await returnFunction(order.id, false, order.email, method);
  } catch (e: any) {
    if (e?.message !== REDIRECTED) throw e;
  }
}

beforeEach(() => {
  calls.self = 0;
  calls.correos = 0;
  calls.amphora = 0;
  written.length = 0;
  stripeUrl = null;
  stripeMethodSeen = null;
  order.returnMethod = null;
  order.locator = null;
  process.env.AMPHORA_INTL_RETURNS_ENABLED = "true";
});

describe("routing a self-booked return", () => {
  it("books no carrier of ours when the customer ships it themselves", async () => {
    await submit("SELF");

    expect(calls.self).toBe(1);
    expect(calls.correos).toBe(0);
    expect(calls.amphora).toBe(0);
  });

  it("still routes an unclaimed return exactly as before", async () => {
    await submit(undefined);

    expect(calls.amphora).toBe(1);
    expect(calls.self).toBe(0);
  });

  it("persists the method before leaving for Stripe", async () => {
    // The webhook has no session and no client state; the row is the only
    // channel that survives the round trip.
    stripeUrl = "https://stripe.test/session";

    await submit("SELF");

    expect(written.some((w) => w.returnMethod === "SELF")).toBe(true);
  });

  it("prices the checkout with the method the customer chose", async () => {
    stripeUrl = "https://stripe.test/session";

    await submit("SELF");

    expect(stripeMethodSeen).toBe("SELF");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selfBookedRouting.test.ts`
Expected: FAIL — `returnFunction` takes three parameters and always routes to Amphora.

- [ ] **Step 3: Modify `actions/return.ts`**

Add imports:

```ts
import { createSelfBookedReturn } from "./selfBookedReturn";
import { resolveReturnMethod, type ReturnMethod } from "@/lib/returnMethods";
import { getFeeTable } from "@/db/fees";
import { loadBasket } from "@/lib/loadBasket";
import { feesForCountry, resolveFee } from "@/lib/fees";
import { resolveZone } from "@/lib/zones";
```

Replace `createReturnShipment` with a method-driven version:

```ts
/**
 * Route the physical return. Three lanes now:
 *  1. SELF     → the customer ships it; we book nothing.
 *  2. AMPHORA  → international collection (gated by the flag).
 *  3. CORREOS  → Spain, or the flag off.
 *
 * Returns an HTTP-style status (200 = success) in every case, so all three are
 * interchangeable to the caller.
 */
async function createReturnShipment(
  id: string,
  method: ReturnMethod
): Promise<number> {
  if (method === "SELF") return createSelfBookedReturn(id);
  if (method === "AMPHORA") return createInternationalReturn(id);
  return createShippingLabel(id);
}

/**
 * What the customer's claimed method actually resolves to, and the return-leg
 * price that decides whether SELF was even on offer.
 *
 * Derived server-side from the order and the fee table, never from the client —
 * the same rule `createStripeUrl` applies to the amount.
 */
async function decideMethod(id: string, claimed: unknown): Promise<ReturnMethod> {
  const amphoraEnabled = process.env.AMPHORA_INTL_RETURNS_ENABLED === "true";
  const loaded = await loadBasket(id);
  if (!loaded) return "CORREOS";

  const { order, basket } = loaded;
  const feeTable = await getFeeTable();
  const fees = feesForCountry(
    feeTable,
    resolveZone(order.shippingCountry, order.shippingZip)
  );
  const { returnLegCents } = resolveFee(fees, basket);

  return resolveReturnMethod(
    claimed,
    order.shippingCountry,
    amphoraEnabled,
    returnLegCents
  );
}
```

Add a `persistReturnMethod` alongside `persistOrderLocale`:

```ts
/**
 * Persist the lane the customer chose, for the same reason `persistOrderLocale`
 * persists the language: the Stripe webhook is an inbound request from Stripe
 * with no cookies and no client state, so the row is the only channel that
 * survives the redirect.
 *
 * Must run BEFORE `createStripeUrl` — that call reads the order through the
 * request-scoped `cache()`d `getOrderById`, so a later write would be invisible
 * to the free path's own read.
 */
async function persistReturnMethod(id: string, method: ReturnMethod) {
  try {
    await db.update(orders).set({ returnMethod: method }).where(eq(orders.id, id));
  } catch (error) {
    console.error(`Failed to persist return method for order ${id}:`, error);
  }
}
```

Then change `returnFunction`:

```ts
export async function returnFunction(
  id: string,
  isCredit: boolean,
  email: string,
  claimedMethod?: unknown
) {
```

and, immediately after the existing `await persistOrderLocale(id);` line:

```ts
  const method = await decideMethod(id, claimedMethod);
  await persistReturnMethod(id, method);
```

Change the `createStripeUrl` call (replacing the placeholder from Task 3):

```ts
  const url = (await createStripeUrl(id, email, isCredit, method)).data;
```

and the shipment call:

```ts
    const statusLabel = await createReturnShipment(id, method);
```

- [ ] **Step 4: Modify the Stripe webhook**

In `app/api/webhooks/stripe/route.ts`, replace the `useAmphora` block:

```ts
        const order = await getOrderById(id);
        // The lane the customer chose, persisted before they left for Stripe.
        // Null on rows created before self-booking existed, which fall back to
        // the country rule exactly as they always did.
        const method: ReturnMethod =
          ((order as any)?.returnMethod as ReturnMethod) ??
          defaultMethodFor(
            order?.shippingCountry,
            process.env.AMPHORA_INTL_RETURNS_ENABLED === "true"
          );
        const statusLabel =
          method === "SELF"
            ? await createSelfBookedReturn(id)
            : method === "AMPHORA"
              ? await createInternationalReturn(id)
              : await createShippingLabel(id);
```

updating the `alertPaidButNoReturn` detail string from `useAmphora ? … : …` to `method`, and adding:

```ts
import { createSelfBookedReturn } from "@/actions/selfBookedReturn";
import { defaultMethodFor, type ReturnMethod } from "@/lib/returnMethods";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/selfBookedRouting.test.ts && npm test && npx tsc --noEmit`
Expected: new test PASSES, all existing tests pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add actions/return.ts app/api/webhooks/stripe/route.ts tests/selfBookedRouting.test.ts
git commit -m "feat: route self-booked returns on both the free and paid paths"
```

---

# Phase 3 — Customer UI

**Gate:** a customer can pick the lane and later submit tracking, in both languages, without touching the database by hand.

## Task 8: Offer the choice on the summary screen

**Files:**
- Create: `app/[id]/components/returnMethodChoice.tsx`
- Modify: `app/[id]/windows/lastWindow.tsx`, `app/[id]/components/buttons/asyncButton.tsx`
- Modify: `lib/i18n/es.ts`, `lib/i18n/en.ts`
- Test: `tests/returnMethodChoice.render.test.tsx`

**Interfaces:**
- Consumes: `selfBookingOffered` from `@/lib/returnMethods`; `useFees` from `../feesContext`
- Produces: `<ReturnMethodChoice value={…} onChange={…} returnLegCents={…} />`; `AsyncButton` gains a `method: "CORREOS" | "AMPHORA" | "SELF"` prop that it forwards to `returnFunction`.

- [ ] **Step 1: Write the failing test**

Create `tests/returnMethodChoice.render.test.tsx`, following the pattern in the existing `tests/returnStatusPanel.render.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReturnMethodChoice } from "@/app/[id]/components/returnMethodChoice";

vi.mock("@/lib/i18n/context", () => ({
  useT: () => ({
    method: {
      ourLabel: "We ship it",
      selfLabel: "I'll ship it myself",
      selfHint: "You arrange the courier and pay the postage.",
      free: "free",
    },
  }),
  useLocale: () => "en",
}));

describe("ReturnMethodChoice", () => {
  it("offers self-booking when our return leg costs money", () => {
    render(
      <ReturnMethodChoice value="AMPHORA" onChange={() => {}} returnLegCents={650} />
    );

    expect(screen.getByText("I'll ship it myself")).toBeTruthy();
  });

  it("renders nothing at all when our own leg is free", () => {
    // Offering it here could only cost them more.
    const { container } = render(
      <ReturnMethodChoice value="CORREOS" onChange={() => {}} returnLegCents={0} />
    );

    expect(container.textContent).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/returnMethodChoice.render.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the copy**

In `lib/i18n/es.ts` and `lib/i18n/en.ts`, add a `method` block beside the existing `last` block:

```ts
  // es.ts
  method: {
    title: "¿Cómo quieres enviarlo?",
    ourLabel: "Lo enviamos nosotros",
    selfLabel: "Lo envío yo",
    selfHint:
      "Tú eliges el transportista y pagas el envío. Después nos dices el número de seguimiento.",
    free: "gratis",
  },
```

```ts
  // en.ts
  method: {
    title: "How would you like to send it?",
    ourLabel: "We ship it",
    selfLabel: "I'll ship it myself",
    selfHint:
      "You choose the carrier and pay the postage. Afterwards you tell us the tracking number.",
    free: "free",
  },
```

- [ ] **Step 4: Write the component**

Create `app/[id]/components/returnMethodChoice.tsx`:

```tsx
"use client";

import { selfBookingOffered, type ReturnMethod } from "@/lib/returnMethods";
import { useT } from "@/lib/i18n/context";

type Props = {
  value: ReturnMethod;
  onChange: (method: ReturnMethod) => void;
  /** What OUR lane charges for the customer's parcel coming back. */
  returnLegCents: number;
  /** The lane we would use if they do not self-book. */
  ourMethod?: ReturnMethod;
};

/**
 * Renders nothing when our own return leg is free — self-booking could only
 * cost the customer more, and offering it would invite people to pay postage
 * they did not need to pay.
 */
export function ReturnMethodChoice({
  value,
  onChange,
  returnLegCents,
  ourMethod = "CORREOS",
}: Props) {
  const t = useT();
  if (!selfBookingOffered(returnLegCents)) return null;

  return (
    <fieldset className="w-full flex flex-col gap-2 mt-4">
      <legend className="font-bold text-base">{t.method.title}</legend>

      <label className="flex items-start gap-3 border rounded-xl p-3 cursor-pointer">
        <input
          type="radio"
          name="returnMethod"
          checked={value !== "SELF"}
          onChange={() => onChange(ourMethod)}
        />
        <span className="text-sm font-bold">{t.method.ourLabel}</span>
      </label>

      <label className="flex items-start gap-3 border rounded-xl p-3 cursor-pointer">
        <input
          type="radio"
          name="returnMethod"
          checked={value === "SELF"}
          onChange={() => onChange("SELF")}
        />
        <span className="flex flex-col">
          <span className="text-sm font-bold">
            {t.method.selfLabel} — {t.method.free}
          </span>
          <span className="text-xs text-slate-600">{t.method.selfHint}</span>
        </span>
      </label>
    </fieldset>
  );
}
```

- [ ] **Step 5: Wire it into `lastWindow.tsx`**

Add `useState` for the method, compute `returnLegCents` from the same `resolveFee(fees, basket)` call already in the `useMemo`, render `<ReturnMethodChoice />` above the summary, and recompute `finalTotal` so the on-screen total matches what Stripe will charge:

```tsx
  const [method, setMethod] = useState<ReturnMethod>("CORREOS");
  const { finalTotal, returnLegCents } = useMemo(() => {
    const basket = valueBasket(items, allProducts);
    const { feeCents, returnLegCents, outboundLegCents } = resolveFee(fees, basket);
    // Mirror the server: SELF pays the outbound leg only.
    const chargeCents = method === "SELF" ? outboundLegCents : feeCents;
    const totalPrice = basket.netAmount - centsToEuros(chargeCents);
    return {
      finalTotal: credito ? totalPrice * 1.15 : totalPrice,
      returnLegCents,
    };
  }, [allProducts, credito, items, fees, method]);
```

Pass `method` down to whatever renders `AsyncButton`.

- [ ] **Step 6: Forward the method from `asyncButton.tsx`**

Add `method` to the props and the call:

```tsx
          await returnFunction(id, isCredit, email, method);
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/returnMethodChoice.render.test.tsx && npm test && npx tsc --noEmit`
Expected: PASS, all green.

- [ ] **Step 8: Commit**

```bash
git add app/\[id\]/components/returnMethodChoice.tsx app/\[id\]/windows/lastWindow.tsx app/\[id\]/components/buttons/asyncButton.tsx lib/i18n/es.ts lib/i18n/en.ts tests/returnMethodChoice.render.test.tsx
git commit -m "feat: let the customer choose to ship the return themselves"
```

## Task 9: The tracking capture screen

**Files:**
- Create: `app/[id]/components/trackingCapture.tsx`
- Modify: `app/[id]/clientOrder.tsx`
- Modify: `lib/i18n/es.ts`, `lib/i18n/en.ts`
- Test: `tests/trackingCapture.render.test.tsx`

**Interfaces:**
- Consumes: `submitReturnTracking` (Task 6), `CARRIERS` (Task 6)
- Produces: `<TrackingCapture id={…} />`, rendered when `returnMethod === "SELF" && !locator`.

- [ ] **Step 1: Write the failing test**

Create `tests/trackingCapture.render.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrackingCapture } from "@/app/[id]/components/trackingCapture";

vi.mock("@/actions/selfBookedTracking", () => ({
  submitReturnTracking: async () => ({ ok: true }),
}));

vi.mock("@/lib/i18n/context", () => ({
  useT: () => ({
    tracking: {
      title: "Tell us the tracking number",
      carrier: "Carrier",
      number: "Tracking number",
      submit: "Send",
      permanent: "We cannot change this later, so please check it carefully.",
    },
  }),
  useLocale: () => "en",
}));

describe("TrackingCapture", () => {
  it("lists the carriers the customer can pick", () => {
    render(<TrackingCapture id="132210" />);

    expect(screen.getByText("DHL")).toBeTruthy();
    expect(screen.getByText("Correos")).toBeTruthy();
  });

  it("warns that the tracking number cannot be changed", () => {
    // Amphora pins carrier_number write-once. A typo is permanent, so the
    // customer has to be told before they commit, not after.
    render(<TrackingCapture id="132210" />);

    expect(
      screen.getByText(/cannot change this later/i)
    ).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/trackingCapture.render.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the copy**

`lib/i18n/es.ts`:

```ts
  tracking: {
    title: "Dinos el número de seguimiento",
    intro:
      "Cuando hayas enviado el paquete, dinos con quién lo has enviado para que el almacén lo espere.",
    carrier: "Transportista",
    number: "Número de seguimiento",
    submit: "Enviar",
    permanent:
      "No podremos cambiarlo después, así que revísalo bien antes de enviarlo.",
    done: "¡Gracias! El almacén ya sabe que tu paquete está en camino.",
    error: "No hemos podido guardarlo. Revisa los datos e inténtalo de nuevo.",
  },
```

`lib/i18n/en.ts`:

```ts
  tracking: {
    title: "Tell us the tracking number",
    intro:
      "Once you have sent the parcel, tell us who you sent it with so the warehouse can expect it.",
    carrier: "Carrier",
    number: "Tracking number",
    submit: "Send",
    permanent: "We cannot change this later, so please check it carefully.",
    done: "Thank you! The warehouse now knows your parcel is on its way.",
    error: "We could not save that. Check the details and try again.",
  },
```

- [ ] **Step 4: Write the component**

Create `app/[id]/components/trackingCapture.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { submitReturnTracking } from "@/actions/selfBookedTracking";
import { CARRIERS } from "@/lib/carriers";
import { useT } from "@/lib/i18n/context";

/**
 * Shown when a self-booked return is still waiting for its tracking number.
 *
 * The confirm step is not decoration: Amphora pins `carrier_number` at approve
 * and it can never be corrected, so a typo desyncs the warehouse permanently.
 */
export function TrackingCapture({ id }: { id: string }) {
  const t = useT();
  const [carrier, setCarrier] = useState(CARRIERS[0].code);
  const [number, setNumber] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<"idle" | "done" | "error">("idle");
  const [isPending, startTransition] = useTransition();

  if (result === "done") {
    return <p className="text-sm font-bold">{t.tracking.done}</p>;
  }

  return (
    <div className="w-full flex flex-col gap-3 mt-4">
      <h3 className="font-bold text-base">{t.tracking.title}</h3>
      <p className="text-sm text-slate-600">{t.tracking.intro}</p>

      <label className="flex flex-col gap-1 text-sm">
        {t.tracking.carrier}
        <select
          className="border rounded-lg p-2"
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
        >
          {CARRIERS.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t.tracking.number}
        <input
          className="border rounded-lg p-2"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
      </label>

      <p className="text-xs text-slate-600">{t.tracking.permanent}</p>
      {result === "error" && (
        <p className="text-xs text-red-600">{t.tracking.error}</p>
      )}

      <button
        type="button"
        className="bg-white text-black border border-black py-3 rounded-full font-bold disabled:opacity-60"
        disabled={isPending || !number.trim()}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          startTransition(async () => {
            const outcome = await submitReturnTracking(id, carrier, number.trim());
            setResult(outcome.ok ? "done" : "error");
            setConfirming(false);
          });
        }}
      >
        {confirming ? `${t.tracking.submit} — ${number.trim()}` : t.tracking.submit}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Render it from `clientOrder.tsx`**

Where the order is already loaded, add:

```tsx
{order.returnMethod === "SELF" && !order.locator && (
  <TrackingCapture id={order.id} />
)}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/trackingCapture.render.test.tsx && npm test && npx tsc --noEmit`
Expected: PASS, all green.

- [ ] **Step 7: Commit**

```bash
git add app/\[id\]/components/trackingCapture.tsx app/\[id\]/clientOrder.tsx lib/i18n/es.ts lib/i18n/en.ts tests/trackingCapture.render.test.tsx
git commit -m "feat: let the customer submit their own tracking number"
```

---

# Phase 4 — Safety nets

**Gate:** no self-booked return can sit unnoticed, and a customer who changes their mind before posting can still cancel.

## Task 10: `lib/selfReturnNudges.ts` — which nudge is due

**Files:**
- Create: `lib/selfReturnNudges.ts`
- Test: `tests/selfReturnNudges.test.ts`

**Interfaces:**
- Produces:
  - `type NudgeDecision = { due: "none" } | { due: "reminder"; nextStage: 1 } | { due: "alert"; nextStage: 2 }`
  - `type NudgeableOrder = { returnMethod?: string | null; returnSubmittedAt?: Date | null; trackingSubmittedAt?: Date | null; trackingNudgeStage?: number | null }`
  - `nudgeDue(order: NudgeableOrder, now: Date): NudgeDecision`

- [ ] **Step 1: Write the failing test**

Create `tests/selfReturnNudges.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nudgeDue } from "@/lib/selfReturnNudges";

const NOW = new Date("2026-08-21T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const base = {
  returnMethod: "SELF",
  returnSubmittedAt: daysAgo(0),
  trackingSubmittedAt: null,
  trackingNudgeStage: 0,
};

describe("nudgeDue", () => {
  it("does nothing on the day of submission", () => {
    expect(nudgeDue(base, NOW)).toEqual({ due: "none" });
  });

  it("reminds the customer after three days", () => {
    expect(nudgeDue({ ...base, returnSubmittedAt: daysAgo(3) }, NOW)).toEqual({
      due: "reminder",
      nextStage: 1,
    });
  });

  it("does not remind twice", () => {
    // A cron running every 15 minutes would otherwise send 96 a day.
    const already = { ...base, returnSubmittedAt: daysAgo(5), trackingNudgeStage: 1 };

    expect(nudgeDue(already, NOW)).toEqual({ due: "none" });
  });

  it("alerts a human after ten days", () => {
    const stale = { ...base, returnSubmittedAt: daysAgo(10), trackingNudgeStage: 1 };

    expect(nudgeDue(stale, NOW)).toEqual({ due: "alert", nextStage: 2 });
  });

  it("does not alert twice", () => {
    const done = { ...base, returnSubmittedAt: daysAgo(40), trackingNudgeStage: 2 };

    expect(nudgeDue(done, NOW)).toEqual({ due: "none" });
  });

  it("skips a return whose tracking already arrived", () => {
    const tracked = {
      ...base,
      returnSubmittedAt: daysAgo(30),
      trackingSubmittedAt: daysAgo(29),
    };

    expect(nudgeDue(tracked, NOW)).toEqual({ due: "none" });
  });

  it("skips lanes that are not self-booked", () => {
    const correos = { ...base, returnMethod: "CORREOS", returnSubmittedAt: daysAgo(30) };

    expect(nudgeDue(correos, NOW)).toEqual({ due: "none" });
  });

  it("skips a row with no submission stamp rather than treating it as ancient", () => {
    // Legacy rows have no timestamp at all. Reading null as epoch would alert
    // on every order we have ever stored.
    const legacy = { ...base, returnSubmittedAt: null };

    expect(nudgeDue(legacy, NOW)).toEqual({ due: "none" });
  });

  it("skips straight to the alert if the reminder was never sent", () => {
    // A ten-day-old return that somehow missed its reminder still needs a
    // human, and jumping the stage is better than re-sending a stale nudge.
    const skipped = { ...base, returnSubmittedAt: daysAgo(12), trackingNudgeStage: 0 };

    expect(nudgeDue(skipped, NOW)).toEqual({ due: "alert", nextStage: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selfReturnNudges.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Pure — no db, no network, and no clock of its own. `now` is a parameter so
// the whole 3/10-day matrix is testable without waiting ten days.

export type NudgeDecision =
  | { due: "none" }
  | { due: "reminder"; nextStage: 1 }
  | { due: "alert"; nextStage: 2 };

export type NudgeableOrder = {
  returnMethod?: string | null;
  returnSubmittedAt?: Date | null;
  trackingSubmittedAt?: Date | null;
  trackingNudgeStage?: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_AFTER_DAYS = 3;
export const ALERT_AFTER_DAYS = 10;

const NONE: NudgeDecision = { due: "none" };

/**
 * Which nudge, if any, this return has earned.
 *
 * A self-booked return that never comes back leaves a live Shopify return and a
 * PENDING warehouse ticket. Order #311174 is the standing lesson: a state
 * nobody is told about persists until the customer complains.
 */
export function nudgeDue(order: NudgeableOrder, now: Date): NudgeDecision {
  if (order.returnMethod !== "SELF") return NONE;
  if (order.trackingSubmittedAt) return NONE;

  // Legacy rows carry no stamp. Reading null as the epoch would make every one
  // of them infinitely overdue and alert on the entire order book.
  const submitted = order.returnSubmittedAt;
  if (!submitted) return NONE;

  const stage = order.trackingNudgeStage ?? 0;
  if (stage >= 2) return NONE;

  const ageDays = (now.getTime() - submitted.getTime()) / DAY_MS;

  if (ageDays >= ALERT_AFTER_DAYS) return { due: "alert", nextStage: 2 };
  if (ageDays >= REMINDER_AFTER_DAYS && stage < 1) {
    return { due: "reminder", nextStage: 1 };
  }
  return NONE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/selfReturnNudges.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/selfReturnNudges.ts tests/selfReturnNudges.test.ts
git commit -m "feat: decide when a self-booked return needs chasing"
```

## Task 11: The sweep, wired into the existing cron

**Files:**
- Create: `actions/selfReturnSweep.ts`
- Modify: `app/api/cron/amphora-sync/route.ts` (add the sweep before the final `NextResponse.json`)
- Modify: `db/queries.ts` (add `getSelfReturnsAwaitingTracking`)
- Test: `tests/selfReturnSweep.test.ts`

**Interfaces:**
- Consumes: `nudgeDue` (Task 10), `sendSelfReturnReminder` (Task 4), `alertOps`
- Produces:
  - `db/queries.ts`: `getSelfReturnsAwaitingTracking(): Promise<Array<typeof orders.$inferSelect>>`
  - `actions/selfReturnSweep.ts`: `sweepSelfReturns(now?: Date): Promise<{ reminded: number; alerted: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/selfReturnSweep.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-08-21T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

const rows: any[] = [];
const reminders: any[] = [];
const alerts: any[] = [];
const written: any[] = [];

vi.mock("@/db/queries", () => ({
  getSelfReturnsAwaitingTracking: async () => rows,
}));

vi.mock("@/lib/emails", () => ({
  sendSelfReturnReminder: async (to: string) => {
    reminders.push(to);
    return 200;
  },
}));

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      written.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

async function sweep() {
  const { sweepSelfReturns } = await import("@/actions/selfReturnSweep");
  return sweepSelfReturns(NOW);
}

const row = (over: Record<string, any> = {}) => ({
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  shippingName: "Ferran Palma",
  locale: "es",
  returnMethod: "SELF",
  returnSubmittedAt: daysAgo(4),
  trackingSubmittedAt: null,
  trackingNudgeStage: 0,
  ...over,
});

beforeEach(() => {
  rows.length = 0;
  reminders.length = 0;
  alerts.length = 0;
  written.length = 0;
});

describe("sweepSelfReturns", () => {
  it("reminds a customer who has not sent tracking in three days", async () => {
    rows.push(row());

    await expect(sweep()).resolves.toEqual({ reminded: 1, alerted: 0 });
    expect(reminders).toEqual(["customer@example.com"]);
  });

  it("advances the stage BEFORE sending, so a redelivery cannot double-send", async () => {
    // Same ordering applyReturnStatus uses. The cost is that a failed send is
    // not retried, which is why the failure is logged loudly.
    rows.push(row());

    await sweep();

    expect(written[0]).toEqual({ trackingNudgeStage: 1 });
  });

  it("alerts a human after ten days", async () => {
    rows.push(row({ returnSubmittedAt: daysAgo(11), trackingNudgeStage: 1 }));

    await expect(sweep()).resolves.toEqual({ reminded: 0, alerted: 1 });
    expect(alerts).toHaveLength(1);
    expect(`${alerts[0].subject}\n${alerts[0].body}`).toContain("#311174");
  });

  it("does nothing on a second pass", async () => {
    rows.push(row({ trackingNudgeStage: 1 }));

    await expect(sweep()).resolves.toEqual({ reminded: 0, alerted: 0 });
    expect(reminders).toHaveLength(0);
  });

  it("keeps sweeping when one row throws", async () => {
    // One bad row must not rob the others of their notification — the same
    // rule the Amphora sync applies.
    rows.push(row({ email: null }), row({ id: "999", orderNumber: "#311175" }));

    const result = await sweep();

    expect(result.reminded).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/selfReturnSweep.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the query**

In `db/queries.ts`:

```ts
/**
 * Self-booked returns still waiting for the customer's tracking number.
 *
 * Deliberately NOT cached — the nudge sweep must see stage changes made by its
 * own previous pass.
 */
export async function getSelfReturnsAwaitingTracking() {
  return db.query.orders.findMany({
    where: and(
      eq(orders.returnMethod, "SELF"),
      isNull(orders.trackingSubmittedAt),
      isNotNull(orders.returnSubmittedAt),
      lt(orders.trackingNudgeStage, 2)
    ),
  });
}
```

adding `isNull`, `isNotNull`, `lt` to the existing `drizzle-orm` import.

- [ ] **Step 4: Write the sweep**

Create `actions/selfReturnSweep.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getSelfReturnsAwaitingTracking } from "@/db/queries";
import { nudgeDue, ALERT_AFTER_DAYS } from "@/lib/selfReturnNudges";
import { sendSelfReturnReminder } from "@/lib/emails";
import { readLocale } from "@/lib/i18n";
import { alertOps } from "./opsAlert";

/**
 * Chase self-booked returns that never came back with a tracking number.
 *
 * Runs from the existing amphora-sync cron rather than a new one: that route
 * already fires every 15 minutes and already carries CRON_SECRET, so there is
 * nothing new to misconfigure.
 */
export async function sweepSelfReturns(
  now: Date = new Date()
): Promise<{ reminded: number; alerted: number }> {
  const rows = await getSelfReturnsAwaitingTracking();
  let reminded = 0;
  let alerted = 0;

  for (const order of rows) {
    try {
      const decision = nudgeDue(order as any, now);
      if (decision.due === "none") continue;

      // Stage first, send second — the same ordering `applyReturnStatus` uses.
      // The next tick then finds the stage advanced and does nothing, so a
      // 15-minute cron cannot send 96 reminders a day. A failed send is not
      // retried, hence the loud log below.
      await db
        .update(orders)
        .set({ trackingNudgeStage: decision.nextStage })
        .where(eq(orders.id, order.id));

      if (decision.due === "reminder") {
        const status = await sendSelfReturnReminder(
          order.email,
          order.shippingName,
          readLocale(order.locale),
          order.id
        );
        if (status !== 200) {
          console.error(
            `[self-return-sweep] reminder for ${order.orderNumber} failed (${status}) and will not be retried.`
          );
        }
        reminded += 1;
        continue;
      }

      await alertOps(
        `[returns] SELF RETURN, NO TRACKING — ${order.orderNumber}`,
        [
          `A customer chose to ship their own return and never told us how.`,
          ``,
          `Order:     ${order.orderNumber} (id ${order.id})`,
          `Customer:  ${order.email}`,
          `Submitted: ${order.returnSubmittedAt?.toISOString() ?? "(unknown)"}`,
          `Waiting:   ${ALERT_AFTER_DAYS}+ days, reminder already sent`,
          ``,
          `The Shopify return is live and the Amphora ticket is still PENDING,`,
          `so no courier was ever dispatched and nothing was charged. Decide`,
          `whether to chase them, cancel the return, or leave it open.`,
        ].join("\n")
      );
      alerted += 1;
    } catch (error: any) {
      // One bad row must not stop the sweep — the others are still owed their
      // notification.
      console.error(
        `[self-return-sweep] ${order.orderNumber ?? order.id} failed:`,
        error?.message || error
      );
    }
  }

  return { reminded, alerted };
}
```

- [ ] **Step 5: Call it from the cron**

In `app/api/cron/amphora-sync/route.ts`, add the import and run the sweep just before the final response, folding the counts into the JSON:

```ts
  let selfReturns = { reminded: 0, alerted: 0 };
  try {
    selfReturns = await sweepSelfReturns();
  } catch (error: any) {
    // The Amphora poll above already did its work; a sweep failure must not
    // discard those results.
    console.error("[amphora-sync] self-return sweep failed:", error?.message || error);
  }

  return NextResponse.json({
    scanned,
    changed,
    stranded,
    skipped,
    skippedUnknownCountry,
    skippedNoReturn,
    selfReturns,
  });
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/selfReturnSweep.test.ts && npm test && npx tsc --noEmit`
Expected: PASS, all green.

- [ ] **Step 7: Commit**

```bash
git add actions/selfReturnSweep.ts db/queries.ts app/api/cron/amphora-sync/route.ts tests/selfReturnSweep.test.ts
git commit -m "feat: chase self-booked returns that never sent tracking"
```

## Task 12: Cancellation before the parcel is posted

**Files:**
- Modify: `lib/cancelEligibility.ts:55-82`
- Test: `tests/cancelEligibility.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: nothing new
- Produces: `CancellableOrder` gains two optional fields — `returnMethod?: string | null`, `locator?: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cancelEligibility.test.ts`:

```ts
describe("self-booked returns before the parcel is posted", () => {
  const selfReturn = (over: Record<string, any> = {}) => ({
    products: [{ confirmed: true, refunded: false }],
    returnStatus: null,
    returnMethod: "SELF",
    locator: null,
    ...over,
  });

  it("is cancellable while no tracking exists", () => {
    // Nothing has been booked and nothing posted — strictly safer than a
    // domestic return with a live Correos label, which is already allowed.
    // Without this the customer hits carrier-unreadable and is trapped.
    expect(cancelEligibility(selfReturn(), "unreadable")).toEqual({
      cancellable: true,
    });
  });

  it("falls back to the normal rules once tracking exists", () => {
    const posted = selfReturn({ locator: "JD0123456789" });

    expect(cancelEligibility(posted, "unreadable")).toEqual({
      cancellable: false,
      reason: "carrier-unreadable",
    });
  });

  it("still blocks a settled self-booked return", () => {
    // Money already moved; the lane does not change that.
    const settled = selfReturn({
      products: [{ confirmed: true, refunded: true }],
    });

    expect(cancelEligibility(settled, "unreadable")).toEqual({
      cancellable: false,
      reason: "already-settled",
    });
  });

  it("still blocks when Amphora says the parcel moved", () => {
    const moved = selfReturn({ returnStatus: "RECEIVED" });

    expect(cancelEligibility(moved, "unreadable")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cancelEligibility.test.ts`
Expected: FAIL on the first case — returns `carrier-unreadable`.

- [ ] **Step 3: Write the implementation**

In `lib/cancelEligibility.ts`, extend the type:

```ts
export type CancellableOrder = {
  products?: Array<{ confirmed?: boolean | null; refunded?: boolean | null }> | null;
  returnStatus?: string | null;
  /** 'CORREOS' | 'AMPHORA' | 'SELF'. Null on rows predating self-booking. */
  returnMethod?: string | null;
  /** The customer's own tracking number, once they have given us one. */
  locator?: string | null;
};
```

Then, after the `in-transit` status check and **before** the movement checks, insert:

```ts
  // A self-booked return with no tracking has had nothing booked and nothing
  // posted: no Correos label, no collection, and an Amphora ticket still at
  // PENDING. That is strictly safer to cancel than a domestic return with a
  // live label, which is already allowed.
  //
  // It has to be decided BEFORE the movement checks, because those are what
  // trap these customers: a non-Correos carrier reads `unreadable`, which
  // blocks — correct once a parcel is in the network, wrong for a customer who
  // changed their mind on the way to the post office.
  if (order.returnMethod === "SELF" && !order.locator) {
    return { cancellable: true };
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cancelEligibility.test.ts && npm test && npx tsc --noEmit`
Expected: PASS, all green.

- [ ] **Step 5: Handle the one `SELF` edge in `actions/cancelReturn.ts`**

`cancelReturnFunction` needs **no lane branch** — it already calls
`cancelAmphoraReturn(amphoraOrderIdFromShopifyId(orderId))` unconditionally and
never attempts a Correos void (labels cannot be voided, which is why). A `SELF`
return has a real `PENDING` Amphora ticket, so that call is correct as written.

There is one edge. Step 1 of `cancelReturnFunction` treats an Amphora cancel
failure as **fatal**. If `createSelfBookedReturn` alerted because the ticket was
never opened, there is nothing to cancel, and the customer is blocked from
cancelling a return that exists only on our side. Add the narrow exemption,
immediately inside the existing `catch`:

```ts
  } catch (error: any) {
    // A self-booked return whose ticket was never opened has nothing for
    // Amphora to cancel — createSelfBookedReturn alerts and continues when the
    // create fails. Treating that 404 as fatal would trap the customer in a
    // return that exists only on our side. Any other failure stays fatal: the
    // warehouse still expecting a parcel is exactly what step 1 guards.
    const missing = error?.response?.status === 404;
    if (!((order as any)?.returnMethod === "SELF" && missing)) {
      console.error(
        `Cancel aborted for ${orderId}: Amphora would not cancel the return:`,
        error?.message || error
      );
      return { ok: false, reason: "carrier-cancel-failed" };
    }
    console.warn(
      `Order ${orderId}: no Amphora ticket to cancel for a self-booked return — continuing.`
    );
  }
```

Add a test to `tests/cancelReturn.test.ts` pinning both halves: a `SELF` return
whose Amphora cancel 404s still cancels, and one whose Amphora cancel 500s still
aborts.

- [ ] **Step 6: Commit**

```bash
git add lib/cancelEligibility.ts tests/cancelEligibility.test.ts actions/cancelReturn.ts
git commit -m "feat: let a customer cancel a self-booked return before they post it"
```

---

## Final verification

- [ ] `npm test` — expect 602 + ~55 new tests, all passing
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run build` — green
- [ ] Confirm the DDL from Task 1 is applied in production **before** merging to `main`
- [ ] Manual smoke on a local `next dev` against a real order: pick "I'll ship it myself", confirm no Correos call and a `PENDING` Amphora ticket, then submit tracking and confirm the ticket reaches `APROVED` with the right `carrier_number`

⚠️ **Port check:** `next dev` binds 3001 (or higher) when 3000 is taken by another app. An Express-shaped `{"message":"Cannot GET …"}` 404 means you are talking to the wrong server; Next's own 404 is HTML.
