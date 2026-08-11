import { beforeEach, describe, expect, it, vi } from "vitest";

// Order #311201 (Belgium), production 2026-08-11: the customer submitted at
// 11:34 and again at 11:39, and Postmark shows TWO "Your return was
// successfully created" emails. Amphora did the right thing — one collection,
// reused — but we told the customer about it twice.
//
// Five minutes apart, so no amount of button state prevents this. The server
// has to be the one that knows it has already notified.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const order: Record<string, any> = {
  id: "13225831661894",
  orderNumber: "#311201",
  email: "customer@example.com",
  shippingName: "Dagmar De Vries",
  shippingCountry: "Belgium",
  locale: "en",
  locator: null,
  carrier: null,
  carrierUrl: null,
  products: [
    { variant_id: "1", quantity: 1, action: "DEVOLUCIÓN", confirmed: true },
  ],
};

const BOOKED = {
  id: "SHP 13225831661894",
  external_id: "13225831661894",
  internal_status: "APROVED",
  carrier: "UPS",
  carrier_number: "1Z3EF3229132142990",
  carrier_url: "https://ups.example/1Z3EF3229132142990",
};

const calls = { created: 0, postmark: 0 };
/** What Amphora holds. Empty until the first booking, exactly like the API. */
let booked: any[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => order,
  getVariantSkusByIds: async () => ({ "1": "SKU-1" }),
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      Object.assign(order, values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  getAmphoraReturnsByOrderName: async () => booked,
  createAmphoraReturn: async () => {
    calls.created += 1;
    booked = [BOOKED];
    return BOOKED;
  },
}));

vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) calls.postmark += 1;
      return { status: 200 };
    },
  },
}));

async function submit() {
  const { createInternationalReturn } = await import("@/actions/amphoraReturn");
  return createInternationalReturn(order.id);
}

beforeEach(() => {
  calls.created = 0;
  calls.postmark = 0;
  booked = [];
  order.locator = null;
  order.carrier = null;
  order.carrierUrl = null;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("an international return submitted twice", () => {
  it("books exactly one collection", async () => {
    await submit();
    await submit();

    expect(calls.created).toBe(1);
  });

  it("emails the customer once, not once per attempt", async () => {
    await submit();
    await submit();

    expect(calls.postmark).toBe(1);
  });

  it("still reports success on the duplicate", async () => {
    // The customer's return exists. Reporting failure here makes the caller
    // revert a live collection.
    await submit();

    await expect(submit()).resolves.toBe(200);
  });

  it("still emails on a first, genuine submit", async () => {
    await submit();

    expect(calls.created).toBe(1);
    expect(calls.postmark).toBe(1);
    expect(order.locator).toBe(BOOKED.carrier_number);
  });

  it("does email when the collection exists but we never told the customer", async () => {
    // The first attempt booked and then failed to email, so we hold no
    // tracking. A resubmit is the customer's only way out — it must not be
    // silently swallowed as a duplicate.
    booked = [BOOKED];
    order.locator = null;

    await submit();

    expect(calls.created).toBe(0);
    expect(calls.postmark).toBe(1);
  });
});
