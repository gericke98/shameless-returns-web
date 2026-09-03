import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Real 1 kg rows from data/return-tariff.csv, used only by the delivery-zone
// split test below. The Italy-collected tests above never resolve to ES or
// US, so adding these rows does not disturb them.
const ES_BANDS = [
  { maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 850 },
];
const US_BANDS = [
  { maxGrams: 2147483647, returnFeeCents: 2200, exchangeFeeCents: 3496 },
];

const basket = { hasItems: true, netAmount: 0, grams: 500 };
const sessions: any[] = [];

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));
vi.mock("@/db/fees", () => ({
  getFeeTable: async () => ({ "*": BANDS, ES: ES_BANDS, US: US_BANDS }),
}));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: async () => ({ order, catalogue: [], basket }),
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

  it("still charges the return fee on a pure return when not self-booked", async () => {
    // netAmount 3 against a 6.50 return fee: the customer owes the
    // difference. This is the control half of the next test — same
    // netAmount, only the method differs — so together they prove SELF
    // actually changes the outcome rather than the two lanes coincidentally
    // agreeing.
    basket.netAmount = 3;

    await priceIt("AMPHORA");

    expect(chargedCents()).toBe(350);
  });

  it("charges a self-booked pure return nothing at all", async () => {
    // Same netAmount as above, same order — only the method differs. A pure
    // return's outboundLegCents is 0 regardless of method, and SELF charges
    // outboundLegCents only, so nothing is owed and no Stripe session should
    // exist.
    basket.netAmount = 3;

    const result = await priceIt("SELF");

    expect(result.data).toBeNull();
    expect(sessions).toHaveLength(0);
  });

  it("itemises the charge as delivery, never as return shipping", async () => {
    // The customer is paying their own courier for the return leg; billing
    // them a line that says otherwise is the complaint. Counting the lines is
    // not enough — a single line LABELLED "Return shipping" is exactly the
    // thing this claims to prevent, and the count stays 1 either way.
    //
    // The order is Spanish-locale ("es"), so `dictionaries.es` is what
    // `createStripeUrl` labels with.
    const { es } = await import("@/lib/i18n/es");
    await priceIt("SELF");

    const names = sessions[0].line_items.map((li: any) => li.price_data.product_data.name);
    expect(names).toHaveLength(1);
    expect(names).not.toContain(es.summary.returnShipping);
    // A pure return charges nothing at all, so this line exists only on an
    // exchange — and the single leg left is the replacement going out, which
    // is what it has to say.
    expect(names[0]).toBe(es.summary.deliveryShipping);
  });

  it("still names the return leg on a lane we book ourselves", async () => {
    // The control half: the label is only dropped because the customer is not
    // paying for that journey, not because the itemisation went away.
    const { es } = await import("@/lib/i18n/es");

    await priceIt("AMPHORA");

    const names = sessions[0].line_items.map((li: any) => li.price_data.product_data.name);
    expect(names).toContain(es.summary.returnShipping);
    expect(names).toContain(es.summary.deliveryShipping);
  });
});

describe("the real createStripeUrl path charges the delivery zone, not the collection zone", () => {
  // This is the wiring test, not another arithmetic test — deliveryLegCharge.test.ts
  // already proves resolveFee/feeLegsForOrder split correctly in isolation. What
  // that file cannot catch is createStripeUrl calling them wrong (e.g. reverting to
  // sameZone(fees), or passing the wrong order/table). Only a test that drives the
  // real createStripeUrl end-to-end, with a delivery address in a different zone
  // than the collection address, can pin that wiring.
  const originalShippingCountry = order.shippingCountry;
  const originalShippingZip = order.shippingZip;

  afterEach(() => {
    // The `order` object above is shared by every test in this file via the
    // loadBasket mock's closure — restore it so later tests see the Italy
    // address they were written against.
    order.shippingCountry = originalShippingCountry;
    order.shippingZip = originalShippingZip;
    delete (order as any).deliveryName;
    delete (order as any).deliveryAddress1;
    delete (order as any).deliveryZip;
    delete (order as any).deliveryCity;
    delete (order as any).deliveryCountry;
  });

  it("charges the ES-collection + US-delivery split, not either zone's flat fee", async () => {
    order.shippingCountry = "Spain";
    order.shippingZip = "28013"; // peninsular, not an island/enclave prefix
    (order as any).deliveryName = "Ana Ruiz";
    (order as any).deliveryAddress1 = "120 Broadway";
    (order as any).deliveryZip = "10271";
    (order as any).deliveryCity = "New York";
    (order as any).deliveryCountry = "US";

    await priceIt("AMPHORA");

    // Collected in Spain at 5.00/8.50, delivered to the US at 22.00/34.96.
    // returnLegCents = min(850, 500) = 500. outboundLegCents = 3496-2200 = 1296.
    // Total 1796 — distinct from ES-flat (850) and from US-flat (3496), so this
    // assertion cannot pass by accident from either zone alone.
    expect(chargedCents()).toBe(1796);
  });
});
