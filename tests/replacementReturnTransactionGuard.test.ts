import { beforeEach, describe, expect, it, vi } from "vitest";

// `refundSourceFor` runs AFTER `createReturn` has already succeeded against
// Shopify and BEFORE the write that stores `return_id` — the very thing the
// idempotency guard at the top of `updateFinalOrder` checks on a retry. If
// `refundSourceFor` (via `resolveRootOrderId`'s cycle guard, or a failed
// `getOrderByIdFresh` inside the walk) rejects, the Shopify return would exist
// with no `return_id` ever written, so a resubmit or webhook redelivery would
// create a SECOND Shopify return for the same parcel.
//
// This pins the fix: the call is guarded at the call site in
// `actions/updateOrder.ts`, so a rejection degrades to a null transaction
// (refused downstream by `settleReturn` with `no-refund-transaction`, which
// the cron alerts on) instead of throwing out of `updateFinalOrder` and
// skipping the row write.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

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

type Row = {
  variant_id: string;
  confirmed: boolean;
  return_id: string | null;
  action?: string;
  quantity?: number;
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
  data: {
    id: "gid://shopify/Return/1",
    returnLineItems: [
      {
        id: "gid://shopify/ReturnLineItem/1",
        fulfillmentLineItem: { id: "gid://shopify/FulfillmentLineItem/1" },
      },
    ],
    transactionId: "gid://shopify/OrderTransaction/9",
    transactionAmount: "93.28",
  },
}));

vi.mock("@/db/queries", () => ({
  createReturn,
  getFulfillmentLineItems: async () => FULFILLMENT_LINE_ITEMS,
  getOrderById: async () => ({
    id: "13192219558214",
    exchangeOf: "13192219000000",
    shippingCountry: "Germany",
    shippingZip: "80933",
  }),
  getOrderByIdFresh: async () => ({
    id: "13192219558214",
    exchangeOf: "13192219000000",
    shippingCountry: "Germany",
    shippingZip: "80933",
  }),
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

// The failure this test pins: walking `exchange_of` to the root (or reading
// the root's transactions) throws instead of resolving.
vi.mock("@/actions/replacementOrder", () => ({
  refundSourceFor: async () => {
    throw new Error("exchange_of cycle at order 13192219000000");
  },
}));

async function updateFinalOrder(id: string) {
  const mod = await import("@/actions/updateOrder");
  return mod.updateFinalOrder(id, false, false);
}

beforeEach(() => {
  state.rows = [
    { variant_id: "1", confirmed: false, return_id: null, action: "DEVOLUCIÓN", quantity: 1 },
  ];
  state.writes = [];
  createReturn.mockClear();
});

describe("updateFinalOrder — refundSourceFor rejects after Shopify's return already exists", () => {
  it("does not throw out of updateFinalOrder", async () => {
    await expect(updateFinalOrder("13192219558214")).resolves.not.toThrow();
  });

  it("still writes return_id, so a retry hits the idempotency guard instead of duplicating the Shopify return", async () => {
    await updateFinalOrder("13192219558214");

    expect(createReturn).toHaveBeenCalledTimes(1);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      confirmed: true,
      return_id: "gid://shopify/Return/1",
    });
  });

  it("stores a null transaction rather than the return's own placeholder-tainted one", async () => {
    await updateFinalOrder("13192219558214");

    expect(state.writes[0]).toMatchObject({
      transaction_id: null,
      transaction_amount: null,
    });
  });
});
