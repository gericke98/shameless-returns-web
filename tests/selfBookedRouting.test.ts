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
const alerts: any[] = [];
// One shared, ordered log. `written` and a separate "createStripeUrl was
// called" flag are two independent facts with no sequence between them — only
// an interleaved log can prove the row was written BEFORE the customer left
// for Stripe, which is the whole claim.
const events: string[] = [];
let stripeUrl: string | null = null;
let stripeMethodSeen: string | null = null;
// Return leg 6.50 by default. A zone whose return leg is FREE is the case
// `resolveReturnMethod` refuses SELF for — self-booking could only cost that
// customer more.
let bands = [{ maxGrams: 2147483647, returnFeeCents: 650, exchangeFeeCents: 1100 }];
// Simulates the `orders` write failing — a dead connection, or the
// `orders_self_return_needs_carrier` CHECK rejecting SELF on a row that still
// carries a live Correos label.
let persistFails = false;

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
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/actions/payments", () => ({
  createStripeUrl: async (_id: string, _e: string, _c: boolean, method: string) => {
    events.push(`stripe:${method}`);
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

vi.mock("@/db/fees", () => ({ getFeeTable: async () => ({ "*": bands }) }));
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
      chain._pending = values;
      return chain;
    },
    where: async () => {
      const values = chain._pending;
      if (persistFails && "returnMethod" in values) {
        throw new Error("dead connection");
      }
      if ("returnMethod" in values) events.push(`persist:${values.returnMethod}`);
      written.push(values);
      Object.assign(order, values);
    },
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
  alerts.length = 0;
  events.length = 0;
  stripeUrl = null;
  stripeMethodSeen = null;
  persistFails = false;
  bands = [{ maxGrams: 2147483647, returnFeeCents: 650, exchangeFeeCents: 1100 }];
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
    // channel that survives the round trip — so "a write happened" is not the
    // claim. The write has to land BEFORE the redirect, and one shared ordered
    // log is what proves it: asserting on two separate arrays would pass just
    // as happily with the calls the other way round.
    stripeUrl = "https://stripe.test/session";

    await submit("SELF");

    expect(events).toEqual(["persist:SELF", "stripe:SELF"]);
  });

  it("falls back to our own lane when the method could not be persisted", async () => {
    // The row is the ONLY channel that survives the redirect. If the write
    // fails and we price the checkout at the SELF rate anyway, the customer is
    // charged the outbound leg alone and the webhook — reading a null column —
    // then books a full Correos/Amphora lane on top.
    //
    // Deterministically reachable once the deferred DDL lands: the
    // `orders_self_return_needs_carrier` CHECK rejects SELF on a row with a
    // live Correos label, which is exactly a second return on an order that
    // already has one.
    stripeUrl = "https://stripe.test/session";
    persistFails = true;

    await submit("SELF");

    // Italy with Amphora enabled: the address-derived lane, and what the
    // webhook will book.
    expect(stripeMethodSeen).toBe("AMPHORA");
    expect(alerts).toHaveLength(1);
  });

  it("refuses SELF where our own return leg is already free", async () => {
    // The server-side money gate. Self-booking is offered only where our label
    // costs the customer something; where it is free, SELF could only cost
    // them more and would generate untracked parcels for nothing. Unit-tested
    // in returnMethods.test.ts — this is the wiring, which is what a
    // regression would actually break.
    bands = [{ maxGrams: 2147483647, returnFeeCents: 0, exchangeFeeCents: 450 }];

    await submit("SELF");

    expect(calls.self).toBe(0);
    expect(calls.amphora).toBe(1);
    expect(stripeMethodSeen).toBe("AMPHORA");
    expect(written.some((w) => w.returnMethod === "AMPHORA")).toBe(true);
  });

  it("prices the checkout with the method the customer chose", async () => {
    stripeUrl = "https://stripe.test/session";

    await submit("SELF");

    expect(stripeMethodSeen).toBe("SELF");
  });
});
