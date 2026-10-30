import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";

// Checkout saves the agreement, then binds the Stripe session to it. These run
// the REAL createStripeUrl → proposal → db/submissions chain against the REAL
// migration, mocking only Shopify, Stripe and the basket.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const pg = new PGlite();
const db = drizzle(pg, { schema });
vi.mock("@/db/drizzle", () => ({ default: db }));

const order = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  shippingCountry: "Spain",
  shippingZip: "28013",
  locale: "es",
  products: [{ id: 1, lineItemId: "11", new_variant_id: "gid://shopify/ProductVariant/9", reason: "size", notes: null }],
};
// An upgrade: returned 40.00, replacement 60.00, so the customer owes 20.00 + fee.
const basket = {
  hasItems: true,
  grams: 500,
  netAmount: -20,
  netCents: -2000,
  lines: [{ id: 1, action: "CAMBIO", quantity: 1, returnedCents: 4000, replacementCents: 6000, degraded: false }],
};

const sessions: any[] = [];
const stripeHook: { duringCreate: () => Promise<void> } = { duringCreate: async () => {} };
const shopify = { shipped: true };

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));
vi.mock("@/db/fees", () => ({
  getFeeTable: async () => ({ "*": [{ maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 850 }] }),
}));
vi.mock("@/lib/loadBasket", () => ({ loadBasket: async () => ({ order, catalogue: [], basket }) }));
vi.mock("@/db/queries", () => ({ getOrderTotal: async () => ({ id: order.id, fulfillments: [] }) }));
vi.mock("@/lib/fulfillmentLines", () => ({
  resolveFulfillmentLineItems: async (lines: Array<{ productsorderId: number }>) =>
    new Map(
      shopify.shipped
        ? lines.map((l) => [l.productsorderId, `gid://shopify/FulfillmentLineItem/${l.productsorderId}`])
        : []
    ),
}));
vi.mock("@/lib/stripe", () => ({
  stripe: {
    checkout: {
      sessions: {
        create: async (args: any) => {
          sessions.push(args);
          await stripeHook.duringCreate();
          return { id: `cs_${sessions.length}`, url: `https://stripe.test/${sessions.length}` };
        },
      },
    },
  },
}));

async function checkout() {
  const { createStripeUrl } = await import("@/actions/payments");
  return createStripeUrl(order.id, order.email, false, "CORREOS" as any);
}

beforeAll(async () => {
  await pg.exec(readFileSync("drizzle/0006_return_submissions.sql", "utf8"));
});

beforeEach(async () => {
  await pg.exec("DELETE FROM submission_lines; DELETE FROM return_submissions");
  sessions.length = 0;
  stripeHook.duringCreate = async () => {};
  shopify.shipped = true;
  process.env.NEXT_PUBLIC_APP_URL = "https://returns.test";
});

describe("createStripeUrl binds the session to the agreement it saved", () => {
  it("charges the agreed amount, names the submission, and records the session on it", async () => {
    const result = await checkout();

    const [row] = (await pg.query<any>("SELECT * FROM return_submissions")).rows;
    expect(result.submissionId).toBe(row.id);
    expect(sessions[0].client_reference_id).toBe(row.id);
    expect(sessions[0].metadata.submission_id).toBe(row.id);
    expect(row.stripe_session_id).toBe("cs_1");
    expect(row.stripe_charge_cents).toBe(2850);
    const charged = sessions[0].line_items.reduce(
      (sum: number, li: any) => sum + li.price_data.unit_amount * li.quantity,
      0
    );
    expect(charged).toBe(row.stripe_charge_cents);
    const [line] = (await pg.query<any>("SELECT * FROM submission_lines")).rows;
    expect(line.fulfillment_line_item_id).toBe("gid://shopify/FulfillmentLineItem/1");
  });

  it("refuses to hand out a checkout whose submission was replaced while it was being created", async () => {
    // A second tab submits while Stripe is creating this tab's session. This
    // session's submission is now superseded: paying it could only ever raise
    // "PAID, NOT CONFIRMED", so the customer must not be sent to it.
    stripeHook.duringCreate = async () => {
      stripeHook.duringCreate = async () => {};
      await checkout();
    };

    await expect(checkout()).rejects.toThrow(/superseded before checkout/);

    const rows = (await pg.query<any>(
      "SELECT state, stripe_session_id FROM return_submissions ORDER BY created_at"
    )).rows;
    expect(rows.map((r: any) => r.state).sort()).toEqual(["awaiting_payment", "superseded"]);
    // Only the surviving submission carries a session.
    expect(rows.find((r: any) => r.state === "superseded").stripe_session_id).toBeNull();
  });

  it("agrees nothing and charges nothing for a line Shopify never shipped", async () => {
    // No fulfillment line item means no Shopify return can name it. Agreeing
    // terms for it would take money for a return that cannot be made.
    shopify.shipped = false;

    await expect(checkout()).rejects.toThrow(/no fulfillment line item/);

    expect(sessions).toHaveLength(0);
    expect((await pg.query<any>("SELECT count(*)::int AS n FROM return_submissions")).rows[0].n).toBe(0);
  });
});
