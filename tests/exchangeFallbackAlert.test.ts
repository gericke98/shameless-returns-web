import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 4: a degraded exchange price (basis "median" or "none" — the original
// variant has left the catalogue) must reach a human BEFORE the customer is
// charged. lib/basket.ts and lib/replacementPricing.ts stay pure and can only
// report `degraded`; actions/payments.ts, a "use server" module, is the one
// place allowed to import actions/opsAlert.ts and act on it.
//
// This never happened in production (0 of 289 exchange lines), which is
// exactly why the alert exists rather than a data fix.

const vgid = (n: string) => `gid://shopify/ProductVariant/${n}`;

function product(id: string, variants: { id: string; price: string }[]) {
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
  product("14958568177990", [{ id: "54623384404294", price: "69.00" }]),
];

/** A CAMBIO line whose ORIGINAL variant is not in the catalogue at all — this
 *  is the "no fallback ratio available" shape, so replacementPricing prices
 *  it at basis "none" (list price), which is degraded. */
function degradedLine(price: string) {
  return {
    productId: "99999999",
    variant_id: "88888888",
    new_variant_id: vgid("54623384404294"),
    price,
    action: "CAMBIO",
    confirmed: false,
    quantity: 1,
  };
}

/** An ordinary same-product size swap: basis "paid", never degraded. */
function healthyLine() {
  return {
    productId: "14958568177990",
    variant_id: "54623384404294",
    new_variant_id: vgid("54623384404294"),
    price: "69.00",
    action: "CAMBIO",
    confirmed: false,
    quantity: 1,
  };
}

const order: Record<string, any> = {
  id: "13217168851270",
  email: "customer@example.com",
  shippingCountry: "Spain",
  shippingZip: "28001", // peninsular
  locale: "es",
  products: [],
};

const ZERO_FEES = { returnFeeCents: 0, exchangeFeeCents: 0 };
const CHARGED_FEES = { returnFeeCents: 500, exchangeFeeCents: 500 };

/** getFeeTable's shape: a country/zone key to ascending bands. */
function feeTable(fees: { returnFeeCents: number; exchangeFeeCents: number }) {
  return { "*": [{ ...fees, maxGrams: 2147483647 }] };
}

let fees = ZERO_FEES;
const alerts: { subject: string; body: string }[] = [];
const sessionsCreated: any[] = [];

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));

vi.mock("@/db/queries", () => ({
  getOrderById: async () => order,
  getProducts: async () => CATALOGUE,
}));

vi.mock("@/db/fees", () => ({
  getFeeTable: async () => feeTable(fees),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    checkout: {
      sessions: {
        create: async (args: any) => {
          sessionsCreated.push(args);
          return { id: "cs_1", url: "https://checkout.stripe.com/cs_1" };
        },
      },
    },
  },
}));

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

beforeEach(() => {
  fees = ZERO_FEES;
  alerts.length = 0;
  sessionsCreated.length = 0;
  order.products = [];
});

describe("createStripeUrl alerts on a degraded exchange price", () => {
  it("stays silent for an ordinary, fully-resolved exchange", async () => {
    fees = CHARGED_FEES;
    order.products = [healthyLine()];
    const { createStripeUrl } = await import("@/actions/payments");

    await createStripeUrl(order.id, order.email, false, "COURIER" as any);

    expect(alerts).toHaveLength(0);
  });

  it("alerts before charging when a replacement was priced on a fallback", async () => {
    fees = CHARGED_FEES;
    order.products = [degradedLine("10.00")];
    const { createStripeUrl } = await import("@/actions/payments");

    const result = await createStripeUrl(order.id, order.email, false, "COURIER" as any);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subject).toBe("EXCHANGE PRICED ON A FALLBACK");
    expect(alerts[0]?.body).toContain(order.id);
    // The charge itself is unaffected by the alert.
    expect(result.data).toBe("https://checkout.stripe.com/cs_1");
    expect(sessionsCreated).toHaveLength(1);
  });

  it("still alerts even when the degraded basket ends up owing nothing", async () => {
    // Zero fees and a return price that covers the (list-priced) exchange
    // price means totalEuros >= 0 — createStripeUrl bails out with
    // { data: null } and never reaches Stripe. A mispriced basket is still
    // worth a human's attention even when nothing gets charged this time.
    fees = ZERO_FEES;
    order.products = [degradedLine("80.00")]; // 80.00 return vs 69.00 exchange
    const { createStripeUrl } = await import("@/actions/payments");

    const result = await createStripeUrl(order.id, order.email, false, "COURIER" as any);

    expect(result).toEqual({ data: null });
    expect(alerts).toHaveLength(1);
    expect(sessionsCreated).toHaveLength(0);
  });
});
