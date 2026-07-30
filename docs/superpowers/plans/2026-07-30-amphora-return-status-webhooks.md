# Amphora Return-Status Webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive Amphora's return-status webhooks so the customer gets their tracking the moment a carrier is assigned, and gets told when their return reaches the warehouse.

**Architecture:** One public `POST` route authenticated by a shared `X-Secret` header. It matches the payload to an order, hands the decision to a pure function, then executes that function's output: persist first, email second. All branching logic lives in the pure decider so it is testable without HTTP.

**Tech Stack:** Next.js App Router (route handlers), Drizzle ORM + Neon Postgres, Postmark (via axios), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-amphora-return-status-webhooks-design.md`

## Global Constraints

- Wire value for approved is `APROVED` — **one P**. Never `APPROVED`.
- Webhook body is `{ "fulfillment_return": { ... } }`. The fields live one level down.
- The payload has **no `external_id`**. Match on `id` (strip the `SHP ` prefix) or `name`.
- Persist status **before** sending any email. Never the reverse.
- Return **200** for an unmatched order. A non-200 makes Amphora retry forever.
- Emails are single-language. Locale comes from `orders.locale` via `readLocale`, falling back to `"es"`.
- Never send a customer email for `EXCEPTION` or `EXCEPTION_WAREHOUSE`.
- Run `npm test` and `npx tsc --noEmit` before every commit.

---

### Task 1: Add the `return_status` column

**Files:**
- Modify: `db/schema.ts` (the `orders` table, after `carrierUrl`)
- No migration file: this repo applies DDL directly and keeps `db/schema.ts` in sync (same as `carrier` / `carrier_url`).

**Interfaces:**
- Consumes: nothing.
- Produces: `orders.returnStatus` — Drizzle column `returnStatus`, SQL `return_status`, `text`, nullable.

- [ ] **Step 1: Apply the DDL to the production database**

The column is nullable and additive, so existing code ignores it and this is safe to run before any deploy.

```bash
SP=<scratchpad>   # dir holding .env.prod from `vercel env pull`
DB=$(grep '^DATABASE_URL=' $SP/.env.prod | cut -d'"' -f2)
psql "$DB" -v ON_ERROR_STOP=1 -c "ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_status text;"
psql "$DB" -c "\d orders" | grep return_status
```

Expected: `return_status | text | | |`

- [ ] **Step 2: Add the column to the schema**

In `db/schema.ts`, inside `export const orders = pgTable("orders", {...})`, directly after the `carrierUrl` line:

```ts
  // Latest Amphora lifecycle status seen for this return (PENDING / APROVED /
  // TRAVELLING / PROCESSING_WAREHOUSE / RECEIVED / FINISHED / EXCEPTION ...).
  // Written only by the Amphora status webhook. Null means no webhook yet.
  returnStatus: text("return_status"),
```

- [ ] **Step 3: Verify the schema compiles and nothing regressed**

Run: `npx tsc --noEmit && npm test`
Expected: exit 0, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add db/schema.ts
git commit -m "feat: add orders.return_status for Amphora lifecycle tracking"
```

---

### Task 2: The two new email templates

**Files:**
- Modify: `lib/emails.ts`
- Test: `tests/emails.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `ExchangeInfo`, `Locale`, `EmailPayload`, and the module-private `exchangeLine(locale, exchange, style)` helper — all already in `lib/emails.ts`.
- Produces:
  - `buildCollectionScheduledEmail(name: string, locale: Locale, tracking: { number?: string | null; url?: string | null }, exchange?: ExchangeInfo | null): EmailPayload`
  - `buildReturnReceivedEmail(name: string, locale: Locale, exchange?: ExchangeInfo | null): EmailPayload`

- [ ] **Step 1: Write the failing tests**

Append to `tests/emails.test.ts`. Add the two builders to the existing import at the top of the file.

```ts
describe("buildCollectionScheduledEmail", () => {
  const tracking = { number: "1Z999", url: "https://ups.com/1Z999" };

  it("localizes the subject", () => {
    expect(buildCollectionScheduledEmail("Ana", "es", tracking).Subject).toBe(
      "Tu recogida está programada"
    );
    expect(buildCollectionScheduledEmail("Ana", "en", tracking).Subject).toBe(
      "Your collection is scheduled"
    );
  });

  it("shows the carrier tracking link", () => {
    const { HtmlBody } = buildCollectionScheduledEmail("Ana", "en", tracking);
    expect(HtmlBody).toContain("1Z999");
    expect(HtmlBody).toContain("https://ups.com/1Z999");
  });

  it("names the replacement for an exchange", () => {
    const { HtmlBody } = buildCollectionScheduledEmail("Ana", "en", tracking, {
      replacements: ["STAR AMALFI PANTS — Medium (40)"],
    });
    expect(HtmlBody).toContain("STAR AMALFI PANTS — Medium (40)");
  });

  it("stays single-language", () => {
    expect(buildCollectionScheduledEmail("Ana", "es", tracking).HtmlBody).not.toContain(
      "Your collection"
    );
    expect(buildCollectionScheduledEmail("Ana", "en", tracking).HtmlBody).not.toContain(
      "Tu recogida"
    );
  });
});

describe("buildReturnReceivedEmail", () => {
  it("localizes the subject", () => {
    expect(buildReturnReceivedEmail("Ana", "es").Subject).toBe(
      "Hemos recibido tu devolución"
    );
    expect(buildReturnReceivedEmail("Ana", "en").Subject).toBe(
      "We've received your return"
    );
  });

  it("tells an exchange customer their replacement is next", () => {
    const { HtmlBody } = buildReturnReceivedEmail("Ana", "en", {
      replacements: ["STAR AMALFI PANTS — Medium (40)"],
    });
    expect(HtmlBody).toContain("STAR AMALFI PANTS — Medium (40)");
  });

  it("stays single-language", () => {
    expect(buildReturnReceivedEmail("Ana", "en").HtmlBody).not.toContain("Hemos recibido");
    expect(buildReturnReceivedEmail("Ana", "es").HtmlBody).not.toContain("We've received");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/emails.test.ts`
Expected: FAIL — `buildCollectionScheduledEmail is not a function`.

- [ ] **Step 3: Implement both builders**

Append to `lib/emails.ts`:

```ts
/* -------------------------------------------------------------------------- */
/* Amphora lifecycle notifications (driven by the status webhooks)             */
/* -------------------------------------------------------------------------- */

const SCHEDULED_COPY = {
  es: {
    subject: "Tu recogida está programada",
    text: "Tu recogida está programada.",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Ya hemos programado la recogida de tu devolución. El mensajero pasará por tu dirección — no necesitas imprimir nada.",
    tracking: (number: string, url: string) =>
      `Puedes seguir la recogida aquí: <a href="${url}">${number}</a>.`,
    trackingPlain: (number: string) => `Número de seguimiento: <strong>${number}</strong>.`,
    contact: `Si tienes alguna pregunta, escríbenos a ${MAILTO}.`,
    signoff: "Saludos,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "Your collection is scheduled",
    text: "Your collection is scheduled.",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "Your return collection is now scheduled. The courier will come to your address — you don't need to print anything.",
    tracking: (number: string, url: string) =>
      `You can track the collection here: <a href="${url}">${number}</a>.`,
    trackingPlain: (number: string) => `Tracking number: <strong>${number}</strong>.`,
    contact: `If you have any questions, contact us at ${MAILTO}.`,
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildCollectionScheduledEmail(
  name: string,
  locale: Locale,
  tracking: { number?: string | null; url?: string | null },
  exchange?: ExchangeInfo | null
): EmailPayload {
  const c = SCHEDULED_COPY[locale];
  const p = 'style="font-size:16px;color:#555;"';
  // Amphora can assign a number without a customer-facing URL; show what we have
  // rather than dropping the tracking entirely.
  const trackingLine = tracking.number
    ? `<p ${p}>${
        tracking.url
          ? c.tracking(tracking.number, tracking.url)
          : c.trackingPlain(tracking.number)
      }</p>`
    : "";

  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.text,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div>
          <p ${p}>${c.greeting(name)}</p>
          <p ${p}>${c.intro}</p>
          ${trackingLine}
          ${exchangeLine(locale, exchange, p)}
          <p ${p}>${c.contact}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>`,
  };
}

const RECEIVED_COPY = {
  es: {
    subject: "Hemos recibido tu devolución",
    text: "Hemos recibido tu devolución.",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Tu devolución ya ha llegado a nuestro almacén y la estamos revisando.",
    outcomeReturn:
      "En cuanto termine la revisión procesaremos tu reembolso. Te avisaremos.",
    contact: `Si tienes alguna pregunta, escríbenos a ${MAILTO}.`,
    signoff: "Saludos,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "We've received your return",
    text: "We've received your return.",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro: "Your return has arrived at our warehouse and we're checking it now.",
    outcomeReturn:
      "As soon as the check is complete we'll process your refund. We'll let you know.",
    contact: `If you have any questions, contact us at ${MAILTO}.`,
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildReturnReceivedEmail(
  name: string,
  locale: Locale,
  exchange?: ExchangeInfo | null
): EmailPayload {
  const c = RECEIVED_COPY[locale];
  const p = 'style="font-size:16px;color:#555;"';
  // An exchange customer is owed their replacement, not a refund, so the two
  // outcomes are mutually exclusive.
  const outcome = exchange
    ? exchangeLine(locale, exchange, p)
    : `<p ${p}>${c.outcomeReturn}</p>`;

  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.text,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div>
          <p ${p}>${c.greeting(name)}</p>
          <p ${p}>${c.intro}</p>
          ${outcome}
          <p ${p}>${c.contact}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/emails.test.ts && npx tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/emails.ts tests/emails.test.ts
git commit -m "feat: add collection-scheduled and return-received email templates"
```

---

### Task 3: The pure decision function

**Files:**
- Create: `lib/amphoraWebhook.ts`
- Test: `tests/amphoraWebhook.test.ts`

**Interfaces:**
- Consumes: nothing (pure module — no db, no env, no network).
- Produces:
  - `type AmphoraWebhookReturn = { id?: string | null; name?: string | null; internal_status?: string | null; carrier?: string | null; carrier_number?: string | null; carrier_url?: string | null }`
  - `type WebhookEmail = "collectionScheduled" | "returnReceived"`
  - `type WebhookActions = { noop: boolean; persist: { locator?: string; carrier?: string; carrierUrl?: string; returnStatus: string } | null; emails: WebhookEmail[] }`
  - `orderIdFromWebhook(payload: AmphoraWebhookReturn): string | null`
  - `decideWebhookActions(order: { returnStatus?: string | null; locator?: string | null }, payload: AmphoraWebhookReturn): WebhookActions`

- [ ] **Step 1: Write the failing tests**

Create `tests/amphoraWebhook.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  decideWebhookActions,
  orderIdFromWebhook,
} from "@/lib/amphoraWebhook";

const FRESH = { returnStatus: null, locator: null };

describe("orderIdFromWebhook", () => {
  it("strips the SHP prefix Amphora puts on our order id", () => {
    expect(orderIdFromWebhook({ id: "SHP 13194624794950" })).toBe("13194624794950");
  });

  it("returns null when the id is not one of ours", () => {
    expect(orderIdFromWebhook({ id: "RET-9912" })).toBeNull();
    expect(orderIdFromWebhook({})).toBeNull();
  });
});

describe("decideWebhookActions", () => {
  it("treats a repeat of the current status as a no-op", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z999" },
      { internal_status: "TRAVELLING", carrier_number: "1Z999" }
    );
    expect(actions.noop).toBe(true);
    expect(actions.emails).toEqual([]);
    expect(actions.persist).toBeNull();
  });

  it("ignores a payload with no status", () => {
    expect(decideWebhookActions(FRESH, {}).noop).toBe(true);
  });

  it("sends tracking the first time a carrier appears", () => {
    const actions = decideWebhookActions(FRESH, {
      internal_status: "APROVED",
      carrier: "UPS",
      carrier_number: "1Z999",
      carrier_url: "https://ups.com/1Z999",
    });
    expect(actions.emails).toEqual(["collectionScheduled"]);
    expect(actions.persist).toEqual({
      returnStatus: "APROVED",
      locator: "1Z999",
      carrier: "UPS",
      carrierUrl: "https://ups.com/1Z999",
    });
  });

  it("does not resend tracking when we already have it", () => {
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: "1Z999" },
      { internal_status: "TRAVELLING", carrier_number: "1Z999" }
    );
    expect(actions.emails).toEqual([]);
    expect(actions.persist?.returnStatus).toBe("TRAVELLING");
  });

  it("emails on arrival at the warehouse", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z999" },
      { internal_status: "RECEIVED" }
    );
    expect(actions.emails).toEqual(["returnReceived"]);
  });

  it("records an approval with no carrier without emailing", () => {
    // Exactly #310972: approved, warehouse assigned, carrier still pending.
    const actions = decideWebhookActions(FRESH, { internal_status: "APROVED" });
    expect(actions.emails).toEqual([]);
    expect(actions.persist).toEqual({ returnStatus: "APROVED" });
  });

  it("never emails the customer about an exception", () => {
    for (const status of ["EXCEPTION", "EXCEPTION_WAREHOUSE"]) {
      const actions = decideWebhookActions(FRESH, { internal_status: status });
      expect(actions.emails).toEqual([]);
      expect(actions.persist?.returnStatus).toBe(status);
    }
  });

  it("does not clobber known tracking with a payload that omits it", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z999" },
      { internal_status: "RECEIVED" }
    );
    expect(actions.persist).not.toHaveProperty("locator");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/amphoraWebhook.test.ts`
Expected: FAIL — cannot resolve `@/lib/amphoraWebhook`.

- [ ] **Step 3: Implement the module**

Create `lib/amphoraWebhook.ts`:

```ts
// Pure — no db, no env, no network. Decides what a return-status webhook should
// change and which emails it should trigger, so the whole matrix is testable
// without constructing an HTTP request.
//
// Amphora spells approved `APROVED`, with one P. That is the wire value.

export type AmphoraWebhookReturn = {
  id?: string | null;
  name?: string | null;
  internal_status?: string | null;
  carrier?: string | null;
  carrier_number?: string | null;
  carrier_url?: string | null;
};

export type WebhookEmail = "collectionScheduled" | "returnReceived";

export type WebhookActions = {
  noop: boolean;
  persist: {
    locator?: string;
    carrier?: string;
    carrierUrl?: string;
    returnStatus: string;
  } | null;
  emails: WebhookEmail[];
};

const NOOP: WebhookActions = { noop: true, persist: null, emails: [] };

/**
 * Our order id, recovered from Amphora's return id.
 *
 * The webhook payload carries no `external_id` — unlike every other Amphora
 * record we handle — so this prefix is the only direct link back. Callers must
 * fall back to matching `name` against `orders.orderNumber` when this is null.
 */
export function orderIdFromWebhook(
  payload: AmphoraWebhookReturn
): string | null {
  const id = payload.id?.trim();
  if (!id?.startsWith("SHP ")) return null;
  return id.slice(4).trim() || null;
}

export function decideWebhookActions(
  order: { returnStatus?: string | null; locator?: string | null },
  payload: AmphoraWebhookReturn
): WebhookActions {
  const status = payload.internal_status?.trim();
  if (!status) return NOOP;

  // Amphora retries, and can redeliver an event we have already acted on.
  // Acting only on a genuine transition is what keeps the customer from being
  // emailed twice.
  if (order.returnStatus === status) return NOOP;

  const persist: NonNullable<WebhookActions["persist"]> = { returnStatus: status };
  // Only ever ADD tracking. A later event that omits the carrier must not wipe
  // tracking we already hold.
  if (payload.carrier_number) persist.locator = payload.carrier_number;
  if (payload.carrier) persist.carrier = payload.carrier;
  if (payload.carrier_url) persist.carrierUrl = payload.carrier_url;

  const emails: WebhookEmail[] = [];
  // Keyed off tracking arriving, not off a particular status: the carrier may
  // first appear on APROVED or on TRAVELLING.
  if (payload.carrier_number && !order.locator) emails.push("collectionScheduled");
  if (status === "RECEIVED") emails.push("returnReceived");

  return { noop: false, persist, emails };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/amphoraWebhook.test.ts && npx tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/amphoraWebhook.ts tests/amphoraWebhook.test.ts
git commit -m "feat: pure decision logic for Amphora return-status webhooks"
```

---

### Task 4: The route handler

**Files:**
- Create: `app/api/webhooks/amphora/route.ts`
- Test: `tests/amphoraWebhookRoute.test.ts`

**Interfaces:**
- Consumes: `decideWebhookActions`, `orderIdFromWebhook`, `AmphoraWebhookReturn` (Task 3); `buildCollectionScheduledEmail`, `buildReturnReceivedEmail` (Task 2); `orders.returnStatus` (Task 1); existing `readLocale`, `exchangeFromProducts`, `db`.
- Produces: `POST` handler at `/api/webhooks/amphora`.

- [ ] **Step 1: Write the failing tests**

Create `tests/amphoraWebhookRoute.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER: any = {
  id: "13194624794950",
  orderNumber: "#310972",
  email: "customer@example.com",
  shippingName: "Mário Lourenço",
  locale: "en",
  locator: null,
  returnStatus: null,
  products: [{ action: "CAMBIO", title: "PANTS", new_variant_title: "Medium (40)" }],
};

const found: { order: any } = { order: ORDER };
const writes: any[] = [];
const emails: any[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => found.order,
  getOrderByNumber: async () => found.order,
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (v: unknown) => {
      writes.push(v);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("axios", () => ({
  default: {
    post: async (_url: string, body: any) => {
      emails.push(body);
      return { status: 200 };
    },
  },
}));

async function post(body: unknown, secret?: string) {
  const { POST } = await import("@/app/api/webhooks/amphora/route");
  return POST(
    new Request("https://example.com/api/webhooks/amphora", {
      method: "POST",
      headers: secret ? { "X-Secret": secret } : {},
      body: JSON.stringify(body),
    })
  );
}

const TRACKING = {
  fulfillment_return: {
    id: "SHP 13194624794950",
    name: "#310972",
    internal_status: "APROVED",
    carrier: "UPS",
    carrier_number: "1Z999",
    carrier_url: "https://ups.com/1Z999",
  },
};

beforeEach(() => {
  writes.length = 0;
  emails.length = 0;
  found.order = { ...ORDER };
  process.env.AMPHORA_WEBHOOK_SECRET = "s3cret";
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("POST /api/webhooks/amphora", () => {
  it("rejects a request with no secret", async () => {
    const res = await post(TRACKING);
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it("rejects a wrong secret", async () => {
    const res = await post(TRACKING, "wrong");
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it("rejects everything when the secret is not configured", async () => {
    delete process.env.AMPHORA_WEBHOOK_SECRET;
    const res = await post(TRACKING, "s3cret");
    expect(res.status).toBe(401);
  });

  it("persists tracking and emails the customer", async () => {
    const res = await post(TRACKING, "s3cret");
    expect(res.status).toBe(200);
    expect(writes[0]).toMatchObject({
      returnStatus: "APROVED",
      locator: "1Z999",
      carrier: "UPS",
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].Subject).toBe("Your collection is scheduled");
    expect(emails[0].To).toBe("customer@example.com");
  });

  it("does nothing on a redelivery", async () => {
    found.order = { ...ORDER, returnStatus: "APROVED", locator: "1Z999" };
    const res = await post(TRACKING, "s3cret");
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  it("returns 200 for a return that is not ours", async () => {
    found.order = null;
    const res = await post(TRACKING, "s3cret");
    // A non-200 would make Amphora retry an unmatchable event forever.
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
  });

  it("returns 400 for an unparseable body", async () => {
    const { POST } = await import("@/app/api/webhooks/amphora/route");
    const res = await POST(
      new Request("https://example.com/api/webhooks/amphora", {
        method: "POST",
        headers: { "X-Secret": "s3cret" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/amphoraWebhookRoute.test.ts`
Expected: FAIL — cannot resolve `@/app/api/webhooks/amphora/route`, and `getOrderByNumber` is not exported from `@/db/queries`.

- [ ] **Step 3: Add the order-by-number lookup**

The webhook can only match on `name` when the `SHP ` prefix is absent. Append to `db/queries.ts`:

```ts
export const getOrderByNumber = cache(async (orderNumber: string) => {
  return db.query.orders.findFirst({
    where: eq(orders.orderNumber, orderNumber),
    with: { products: true },
  });
});
```

- [ ] **Step 4: Implement the route**

Create `app/api/webhooks/amphora/route.ts`:

```ts
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import axios from "axios";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getOrderById, getOrderByNumber } from "@/db/queries";
import {
  buildCollectionScheduledEmail,
  buildReturnReceivedEmail,
} from "@/lib/emails";
import { exchangeFromProducts } from "@/lib/exchange";
import { readLocale } from "@/lib/i18n";
import {
  decideWebhookActions,
  orderIdFromWebhook,
  type AmphoraWebhookReturn,
} from "@/lib/amphoraWebhook";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/**
 * Amphora return-status webhooks.
 *
 * PUBLIC and unauthenticated by cookie — `middleware.ts` matches only
 * /dashboard and /login. The shared `X-Secret` is the ONLY thing in front of
 * this endpoint, so it is checked before any parsing or database access.
 */
function authorized(req: Request): boolean {
  const expected = process.env.AMPHORA_WEBHOOK_SECRET;
  // An unconfigured deployment must be closed, not open.
  if (!expected) return false;

  const got = req.headers.get("x-secret");
  if (!got) return false;

  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so compare lengths first —
  // and keep the comparison constant-time for equal-length inputs.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function sendEmail(payload: Record<string, unknown>): Promise<number> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return 500;
  try {
    const res = await axios.post(POSTMARK_API_URL, payload, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
    });
    return res.status;
  } catch (error: any) {
    console.error(
      "Amphora webhook email error:",
      error?.response?.data || error?.message || error
    );
    return 500;
  }
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { fulfillment_return?: AmphoraWebhookReturn };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = body?.fulfillment_return;
  if (!payload) {
    return NextResponse.json({ error: "Missing fulfillment_return" }, { status: 400 });
  }

  // Returns created through Amphora's own Shopify channel fire these webhooks
  // too. They are not ours, and a non-200 would have Amphora retry forever.
  const id = orderIdFromWebhook(payload);
  const order =
    (id ? await getOrderById(id) : null) ??
    (payload.name ? await getOrderByNumber(payload.name) : null);

  if (!order) {
    console.log(
      `[amphora-webhook] no local order for ${payload.id ?? payload.name} — ignoring`
    );
    return NextResponse.json({ message: "ignored" });
  }

  const actions = decideWebhookActions(order as any, payload);
  if (actions.noop || !actions.persist) {
    return NextResponse.json({ message: "no-op" });
  }

  // Persist BEFORE emailing. A redelivery then finds the status unchanged and
  // does nothing, so the customer can never be emailed twice. The cost is that
  // a failed email is not retried — hence the loud log below.
  await db.update(orders).set(actions.persist).where(eq(orders.id, order.id));

  const locale = readLocale(order.locale);
  const exchange = exchangeFromProducts((order as any).products);

  for (const email of actions.emails) {
    const built =
      email === "collectionScheduled"
        ? buildCollectionScheduledEmail(
            order.shippingName,
            locale,
            { number: payload.carrier_number, url: payload.carrier_url },
            exchange
          )
        : buildReturnReceivedEmail(order.shippingName, locale, exchange);

    const status = await sendEmail({
      ...built,
      To: order.email,
      MessageStream: "outbound",
    });
    if (status !== 200) {
      console.error(
        `[amphora-webhook] order ${order.id}: status saved as ${actions.persist.returnStatus} but the "${email}" email FAILED (${status}). Customer needs a manual notice.`
      );
    }
  }

  if (
    payload.internal_status === "EXCEPTION" ||
    payload.internal_status === "EXCEPTION_WAREHOUSE"
  ) {
    console.error(
      `[amphora-webhook] order ${order.id} (${order.orderNumber}) entered ${payload.internal_status} — needs manual attention.`
    );
  }

  return NextResponse.json({ message: "ok" });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/amphoraWebhookRoute.test.ts && npm test && npx tsc --noEmit`
Expected: all PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/amphora/route.ts tests/amphoraWebhookRoute.test.ts db/queries.ts
git commit -m "feat: receive Amphora return-status webhooks and notify the customer"
```

---

### Task 5: Configure and hand off

**Files:** none (operational).

- [ ] **Step 1: Generate the shared secret**

```bash
openssl rand -hex 32
```

- [ ] **Step 2: Set it in Vercel (all environments)**

```bash
vercel env add AMPHORA_WEBHOOK_SECRET production
vercel env add AMPHORA_WEBHOOK_SECRET preview
```

Paste the value from Step 1 at the prompt.

**Note:** preview shares the production database, so a webhook aimed at a
preview deployment writes to live customer orders. Give Amphora the production
URL only.

- [ ] **Step 3: Confirm the column exists in production before deploying**

```bash
psql "$DB" -c "\d orders" | grep return_status
```

Expected: one row. If missing, go back to Task 1 Step 1 — deploying first makes
every international return 500 on a missing column.

- [ ] **Step 4: Deploy, then verify the endpoint is closed**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://www.shamelesscollective-returns.com/api/webhooks/amphora \
  -H "Content-Type: application/json" -d '{}'
```

Expected: `401`. A 200 here means the secret is not being enforced — stop and fix.

- [ ] **Step 5: Give Amphora the URL and secret**

Send Amphora, for all six return-status events:
- URL: `https://www.shamelesscollective-returns.com/api/webhooks/amphora`
- Header: `X-Secret: <value from Step 1>`

Ask them to confirm which events they will send and whether they need one URL
per event (the same URL can be registered six times).

- [ ] **Step 6: Verify with the first real event**

After Amphora confirms, check that a status lands:

```bash
psql "$DB" -c "select order_number, return_status, locator, carrier from orders where return_status is not null order by order_number desc limit 10;"
```

---

## Backfill note (#310972 and #310761)

Both orders are already `APROVED` in Amphora with `return_status` null locally.
Once the webhook is live, their next transition (carrier assigned, or
travelling) will flow through normally and trigger the tracking email — the
`!order.locator` condition is still satisfied, so Mário gets the tracking email
he was promised without any manual step.

If Amphora only fires webhooks on *future* transitions and never re-sends
`APROVED`, this still works: the carrier assignment is itself a later
transition.
