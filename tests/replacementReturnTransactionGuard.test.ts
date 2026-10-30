import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSubmission, refundableFrom } from "./submissionFixture";

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
      line_items: [{ id: 11, variant_id: 1 }],
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
            lineItem: {
              id: "gid://shopify/LineItem/11",
              variant: { id: "gid://shopify/ProductVariant/1" },
            },
          },
        },
      ],
    },
  },
};

type Row = {
  id: number;
  lineItemId: string;
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
  reserveExchangeStock: async () => {},
}));
vi.mock("@/lib/settlement/holdRelease", () => ({
  releaseHoldForRevert: async () => ({ released: true }),
  releaseHoldForCancellation: async () => ({ released: true }),
}));
vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));

// The failure this test pins: walking `exchange_of` to the root (or reading
// the root's transactions) throws instead of resolving.
vi.mock("@/actions/replacementOrder", () => ({
  refundSourceFor: async () => {
    throw new Error("exchange_of cycle at order 13192219000000");
  },
}));

// The confirm write is one SQL statement now; the test reads what it was given.
const recorded = vi.fn(async (_input: any) => [1]);
vi.mock("@/lib/fulfillmentLines", () => ({
  refundableQuantities: (ids: string[]) => refundableFrom(FULFILLMENT_LINE_ITEMS)(ids),
}));

vi.mock("@/db/submissions", () => ({
  getSubmission: async () => acceptedSubmission("13192219558214", state.rows, { fulfillment: FULFILLMENT_LINE_ITEMS }),
  recordConfirmation: (input: any) => recorded(input),
}));

async function confirm() {
  const mod = await import("@/lib/submissionConfirmation");
  return mod.confirmSubmission("sub-1");
}

beforeEach(() => {
  state.rows = [
    { id: 1, lineItemId: "11", variant_id: "1", confirmed: false, return_id: null, action: "DEVOLUCIÓN", quantity: 1 },
  ];
  state.writes = [];
  createReturn.mockClear();
  recorded.mockClear();
});

describe("confirmSubmission — refundSourceFor rejects after Shopify's return already exists", () => {
  it("does not throw out of confirmSubmission", async () => {
    await expect(confirm()).resolves.not.toThrow();
  });

  it("still records the return line, so a retry hits the idempotency guard instead of duplicating the Shopify return", async () => {
    await confirm();

    expect(createReturn).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0][0]).toMatchObject({
      submissionId: "sub-1",
      returnId: "gid://shopify/Return/1",
      lines: [
        {
          productsorderId: 1,
          fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/1",
          returnLineItemId: "gid://shopify/ReturnLineItem/1",
        },
      ],
    });
  });

  it("stores a null transaction rather than the return's own placeholder-tainted one", async () => {
    await confirm();

    expect(recorded.mock.calls[0][0]).toMatchObject({
      transactionId: null,
      transactionAmount: null,
    });
  });
});
