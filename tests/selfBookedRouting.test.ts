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
