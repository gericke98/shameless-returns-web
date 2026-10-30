import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptedSubmission, refundableFrom } from "./submissionFixture";

// The gap between two correct changes.
//
// `confirmSubmission` bails early on "no returnable lines", but it checks that
// BEFORE `buildReturnInput` runs — and `buildReturnInput` is now the thing that
// drops lines Shopify will not take back (#310828). So an order whose every
// line has been refunded passes the early guard with lines in hand, and then
// reaches `returnCreate` with an EMPTY returnLineItems list.
//
// Nothing downstream wants that call: it spends a Shopify round trip to be told
// something we already knew, and turns a clear "nothing to return" into an
// opaque mutation error on the customer's screen.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const FULFILLMENT_GID = "gid://shopify/Fulfillment/1";
const TOTAL_ORDER = {
  id: "13172075168070",
  fulfillments: [
    { admin_graphql_api_id: FULFILLMENT_GID, line_items: [{ id: 11, variant_id: 1 }] },
  ],
};

/** The one line on the order, already refunded in the admin. */
const FULFILLMENT_LINE_ITEMS = {
  data: {
    fulfillmentLineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/FulfillmentLineItem/1",
            lineItem: {
              id: "gid://shopify/LineItem/11",
              refundableQuantity: 0,
              variant: { id: "gid://shopify/ProductVariant/1" },
            },
          },
        },
      ],
    },
  },
};

const state: { rows: any[]; writes: Array<Record<string, unknown>> } = {
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
    query: { productsOrder: { findMany: async () => state.rows } },
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
  getOrderById: async () => ({ shippingCountry: "Lithuania", shippingZip: "09300" }),
  getOrderByIdFresh: async () => ({ shippingCountry: "Lithuania", shippingZip: "09300" }),
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

const recorded = vi.fn(async () => []);
vi.mock("@/lib/fulfillmentLines", () => ({
  refundableQuantities: (ids: string[]) => refundableFrom(FULFILLMENT_LINE_ITEMS)(ids),
}));

vi.mock("@/db/submissions", () => ({
  getSubmission: async () => acceptedSubmission("13172075168070", state.rows, { fulfillment: FULFILLMENT_LINE_ITEMS }),
  recordConfirmation: (...args: unknown[]) => (recorded as any)(...args),
}));

async function confirm() {
  const mod = await import("@/lib/submissionConfirmation");
  return mod.confirmSubmission("sub-1");
}

beforeEach(() => {
  state.rows = [
    {
      id: 1,
      lineItemId: "11",
      variant_id: "1",
      quantity: 1,
      action: "DEVOLUCIÓN",
      confirmed: false,
      return_id: null,
    },
  ];
  state.writes = [];
  createReturn.mockClear();
  recorded.mockClear();
});

describe("confirmSubmission when every line has become unreturnable", () => {
  it("does not ask Shopify to create an empty return", async () => {
    await confirm();

    expect(createReturn).not.toHaveBeenCalled();
  });

  it("leaves the rows unconfirmed rather than claiming a return exists", async () => {
    await confirm();

    // Confirming here would make `returnOutcome` report success to a customer
    // whose garments were never booked back.
    expect(state.writes.some((w) => w.confirmed === true)).toBe(false);
    expect(recorded).not.toHaveBeenCalled();
  });
});
