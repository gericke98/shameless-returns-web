import { beforeEach, describe, expect, it, vi } from "vitest";

// What the customer paid for is the submission, frozen at checkout. Between
// checkout and payment the rows can change — another tab, a retry — and the
// confirmation must not follow them.
//
// The submission here is written out by hand, NOT derived from the rows the
// way tests/submissionFixture.ts derives it: a confirm that secretly read the
// rows would pass a fixture built from those same rows.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ORDER_ID = "13192219558214";
const AGREED_FLI = "gid://shopify/FulfillmentLineItem/1";

/** The rows NOW: the customer's other tab turned the exchange into a refund. */
const state: { rows: any[]; refundable: Map<string, number | null> } = {
  rows: [],
  refundable: new Map(),
};

/** The rows AT CHECKOUT, as the submission recorded them. */
const SUBMISSION = {
  submission: {
    id: "sub-1",
    orderId: ORDER_ID,
    state: "accepted",
    tender: "refund",
    returnMethod: "CORREOS",
    returnLegCents: 500,
  },
  lines: [
    {
      submissionId: "sub-1",
      productsorderId: 7,
      shopifyLineItemId: "11",
      fulfillmentLineItemId: AGREED_FLI,
      quantity: 1,
      action: "CAMBIO",
      newVariantId: "gid://shopify/ProductVariant/999",
      reason: "size",
      notes: null,
      returnLineItemId: null,
    },
  ],
};

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
    query: { productsOrder: { findMany: async () => state.rows } },
  };
  return { default: chain };
});

const createReturn = vi.fn(async (_input: any) => ({
  success: true as const,
  data: {
    id: "gid://shopify/Return/1",
    returnLineItems: [
      { id: "gid://shopify/ReturnLineItem/1", fulfillmentLineItem: { id: AGREED_FLI } },
    ],
    transactionId: "t",
    transactionAmount: "50.00",
  },
}));

vi.mock("@/db/queries", () => ({
  createReturn: (input: any) => createReturn(input),
  getOrderById: async () => ({ id: ORDER_ID, shippingCountry: "Spain", shippingZip: "28001" }),
  // No fulfillments at all: confirm must not need to resolve anything.
  getOrderTotal: async () => ({ id: ORDER_ID, fulfillments: [] }),
}));

vi.mock("@/lib/fulfillmentLines", () => ({
  refundableQuantities: async (ids: string[]) =>
    new Map(ids.filter((id) => state.refundable.has(id)).map((id) => [id, state.refundable.get(id)!])),
}));

vi.mock("@/actions/replacementOrder", () => ({
  refundSourceFor: async () => ({ transactionId: "t", transactionAmount: "50.00" }),
}));

const reserved = vi.fn(async (_id: string, _lines: any[]) => {});
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async () => {},
  reserveExchangeStock: (id: string, lines: any[]) => reserved(id, lines),
}));

const recorded = vi.fn(async (_input: any) => [7]);
vi.mock("@/db/submissions", () => ({
  getSubmission: async () => SUBMISSION,
  recordConfirmation: (input: any) => recorded(input),
}));

async function confirm() {
  const { confirmSubmission } = await import("@/lib/submissionConfirmation");
  return confirmSubmission("sub-1");
}

beforeEach(() => {
  state.rows = [
    {
      id: 7,
      lineItemId: "11",
      variant_id: "1",
      quantity: 1,
      action: "DEVOLUCIÓN",
      new_variant_id: null,
      confirmed: false,
      return_id: null,
      refunded: false,
    },
  ];
  state.refundable = new Map([[AGREED_FLI, 1]]);
  createReturn.mockClear();
  reserved.mockClear();
  recorded.mockClear();
});

describe("confirmSubmission works from the submission, not the rows", () => {
  it("returns the garment agreed at checkout, by its stored fulfillment line item", async () => {
    await confirm();

    expect(createReturn).toHaveBeenCalledTimes(1);
    const input = createReturn.mock.calls[0][0];
    expect(input.returnLineItems).toEqual([
      expect.objectContaining({ fulfillmentLineItemId: AGREED_FLI, quantity: 1 }),
    ]);
    expect(recorded.mock.calls[0][0].lines).toEqual([
      { productsorderId: 7, fulfillmentLineItemId: AGREED_FLI, returnLineItemId: "gid://shopify/ReturnLineItem/1" },
    ]);
  });

  it("holds the replacement that was paid for, though the row no longer asks for one", async () => {
    await confirm();

    expect(reserved).toHaveBeenCalledWith(ORDER_ID, [
      expect.objectContaining({
        action: "CAMBIO",
        new_variant_id: "gid://shopify/ProductVariant/999",
        quantity: 1,
        confirmed: true,
      }),
    ]);
  });

  it("refuses, before creating anything, when Shopify no longer has the agreed garment", async () => {
    // A cancelled and recreated fulfillment: the id agreed at checkout is gone.
    // Silently dropping the line would leave a paid garment off its return.
    state.refundable = new Map();

    await expect(confirm()).rejects.toThrow(/no longer has/);
    expect(createReturn).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
  });
});
