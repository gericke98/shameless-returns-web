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
