import { beforeEach, describe, expect, it, vi } from "vitest";

// Order #310957. The customer submitted, Shopify created return #310957-R1 and
// Amphora booked the collection, then the request hit the 15s platform timeout.
// She retried; `returnCreate` rejected the second attempt ("Return line item has
// an invalid quantity" — the units were already on R1) and threw, and the
// caller's catch-all revert wiped the state of the FIRST, successful return.
// Result: a live return with a paid-for collection, invisible to the dashboard
// (`getReturns` filters on `confirmed`), and no email to the customer.
//
// Two guards, both pinned here:
//   1. revert must never blank a row that carries a real Shopify `return_id`.
//   2. the create path must bail out entirely when the parcel already has one,
//      so the duplicate `returnCreate` is never attempted.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type Row = {
  variant_id: string;
  confirmed: boolean;
  return_id: string | null;
  action?: string;
  quantity?: number;
};

// Enough Shopify shape that the create path reaches `returnCreate` when the
// guard is removed — otherwise the idempotency test passes for the wrong
// reason (bailing earlier on "no returnable lines") and pins nothing.
const FULFILLMENT_GID = "gid://shopify/Fulfillment/1";
const TOTAL_ORDER = {
  id: "13192219558214",
  fulfillments: [
    {
      admin_graphql_api_id: FULFILLMENT_GID,
      line_items: [{ variant_id: 1 }],
    },
  ],
};
const FULFILLMENT_LINE_ITEMS = {
  data: {
    fulfillmentLineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/FulfillmentLineItem/1",
            lineItem: { variant: { id: "gid://shopify/ProductVariant/1" } },
          },
        },
      ],
    },
  },
};

const state: { rows: Row[]; writes: Array<Record<string, unknown>> } = {
  rows: [],
  writes: [],
};

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, unknown>) => {
      state.writes.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
    query: {
      productsOrder: { findMany: async () => state.rows },
    },
  };
  return { default: chain };
});

const createReturn = vi.fn(async () => ({
  success: true as const,
  data: { id: "gid://shopify/Return/1", returnLineItems: [], transactionId: "t" },
}));

vi.mock("@/db/queries", () => ({
  createReturn,
  getFulfillmentLineItems: async () => FULFILLMENT_LINE_ITEMS,
  getOrderById: async () => ({ shippingCountry: "Germany", shippingZip: "80933" }),
  getOrderProductsById: async () => state.rows,
  getOrderTotal: async () => TOTAL_ORDER,
}));

vi.mock("@/db/fees", () => ({ getFeeTable: async () => [] }));
vi.mock("@/lib/loadBasket", () => ({ loadBasket: async () => null }));
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async () => {},
  reserveExchangeStock: async () => {},
}));
vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));

async function updateFinalOrder(id: string, revert: boolean) {
  const mod = await import("@/actions/updateOrder");
  return mod.updateFinalOrder(id, revert, false);
}

beforeEach(() => {
  state.rows = [];
  state.writes = [];
  createReturn.mockClear();
});

describe("updateFinalOrder — revert must not destroy a real return", () => {
  it("leaves a row that already carries a Shopify return_id untouched", async () => {
    state.rows = [
      { variant_id: "1", confirmed: true, return_id: "gid://shopify/Return/56113398086" },
    ];

    await updateFinalOrder("13192219558214", true);

    expect(state.writes).toHaveLength(0);
  });

  it("still reverts a confirmed row that has no return behind it", async () => {
    state.rows = [{ variant_id: "1", confirmed: true, return_id: null }];

    await updateFinalOrder("13192219558214", true);

    expect(state.writes).toEqual([{ confirmed: false, return_id: null }]);
  });

  it("reverts only the orphan rows when a parcel is half-created", async () => {
    state.rows = [
      { variant_id: "1", confirmed: true, return_id: "gid://shopify/Return/56113398086" },
      { variant_id: "2", confirmed: true, return_id: null },
    ];

    await updateFinalOrder("13192219558214", true);

    expect(state.writes).toEqual([{ confirmed: false, return_id: null }]);
  });
});

describe("updateFinalOrder — a resubmit must not create a second return", () => {
  const RETURNABLE = {
    variant_id: "1",
    confirmed: true,
    action: "DEVOLUCIÓN",
    quantity: 1,
  };

  it("bails out without calling Shopify when the parcel is already returned", async () => {
    state.rows = [{ ...RETURNABLE, return_id: "gid://shopify/Return/56113398086" }];

    await updateFinalOrder("13192219558214", false);

    expect(createReturn).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  // The control: identical row WITHOUT a return_id must still reach Shopify.
  // Without this, the test above would pass even with the guard deleted.
  it("still creates the return on a first submit", async () => {
    state.rows = [{ ...RETURNABLE, confirmed: false, return_id: null }];

    await updateFinalOrder("13192219558214", false);

    expect(createReturn).toHaveBeenCalledTimes(1);
  });
});
