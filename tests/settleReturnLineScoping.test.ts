import { beforeEach, describe, expect, it, vi } from "vitest";

// Two ways one settlement can pay for two garments, and one way an admin
// session can name the money.
//
//   1. `refunded` used to be written by (variant_id, order_id). `productsorder`
//      is keyed per LINE ITEM, so an order carrying two rows for the same
//      variant — two of the same shirt, the case the auto-approve gate's SKU
//      pool exists to handle — had BOTH rows flipped by the one gift card or
//      the one refund actually issued. The second garment came back, was
//      marked paid, and nobody was paid for it.
//
//   2. The refund lane read `price`, `return_id`, `return_line_item_id` and
//      `transaction_id` off the caller's object. The function reloads the row
//      precisely because those decide money; the credit lane already used the
//      reloaded row and the refund lane did not.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

const ORDER: Record<string, any> = {};
const refundCalls: Array<{
  returnId: string;
  returnLineItemId: string;
  transactionId: string;
  amount: number;
}> = [];
const giftCards: number[] = [];
const closedReturns: string[] = [];
const storeCreditRefundCalls: Array<{ returnId: string; returnLineItemId: string }> = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getOrderByIdFresh: async () => ORDER,
  getOrderTotal: async () => ({ id: ORDER.id, customer: { id: "c1" } }),
  processGiftCardReturn: async (_c: string, value: number) => {
    giftCards.push(value);
    return { success: true, data: { id: "gid://shopify/GiftCard/1" } };
  },
  createRefund: async (
    returnId: string,
    returnLineItemId: string,
    transactionId: string,
    amount: number
  ) => {
    refundCalls.push({ returnId, returnLineItemId, transactionId, amount });
    return { success: true };
  },
  createStoreCreditRefund: async (returnId: string, returnLineItemId: string) => {
    storeCreditRefundCalls.push({ returnId, returnLineItemId });
    return { success: true };
  },
  noteStoreCreditOnOrder: async () => ({ success: true }),
  createOrder: async () => ({ success: true }),
  closeReturn: async (returnId: string) => {
    closedReturns.push(returnId);
    return { success: true };
  },
}));

const BANDS = [{ maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 850 }];
vi.mock("@/db/fees", () => ({ getFeeTable: async () => ({ "*": BANDS }) }));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: async () => ({
    order: ORDER,
    catalogue: [],
    basket: { hasItems: true, netAmount: 40, grams: 400 },
  }),
}));
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async () => {},
  reserveExchangeStock: async () => {},
}));
vi.mock("@/actions/opsAlert", () => ({ alertOps: async () => {} }));

/** Every `where(...)` the settle path hands to drizzle, as a SQL object. */
const whereClauses: any[] = [];
const dbLine = { value: null as null | Record<string, unknown> };
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: (clause: unknown) => {
      whereClauses.push(clause);
      return Promise.resolve();
    },
    select: () => chain,
    from: () => Promise.resolve([]),
    query: {
      productsOrder: {
        findFirst: async () => dbLine.value,
        findMany: async () => [],
      },
    },
  };
  return { default: chain };
});

/**
 * Every column named anywhere inside a drizzle SQL fragment.
 *
 * Asserting on the shape of the clause rather than on a row count is the only
 * way a mocked database can prove WHICH rows would have been hit.
 */
function columnsIn(clause: any, found: string[] = []): string[] {
  if (!clause || typeof clause !== "object") return found;
  if (typeof clause.name === "string" && clause.table) found.push(clause.name);
  for (const chunk of clause.queryChunks ?? []) columnsIn(chunk, found);
  return found;
}

const CALLER_LINE = {
  // What the dashboard row / cron hands in. Deliberately disagrees with the
  // stored row on every money-deciding field.
  variant_id: "999",
  price: "100000",
  return_id: "caller-return",
  return_line_item_id: "caller-rli",
  transaction_id: "caller-txn",
};

beforeEach(() => {
  refundCalls.length = 0;
  giftCards.length = 0;
  closedReturns.length = 0;
  storeCreditRefundCalls.length = 0;
  whereClauses.length = 0;
  for (const key of Object.keys(ORDER)) delete ORDER[key];
  Object.assign(ORDER, {
    id: "13000000000001",
    orderNumber: "#311500",
    shippingCountry: "Spain",
    shippingZip: "28001",
    returnMethod: "CORREOS",
    products: [],
  });
  dbLine.value = {
    id: 4242,
    orderId: "13000000000001",
    variant_id: "999",
    price: "40.00",
    credit: false,
    action: "DEVOLUCIÓN",
    refunded: false,
    return_id: "row-return",
    return_line_item_id: "row-rli",
    transaction_id: "row-txn",
  };
});

async function settle(product: Record<string, any>) {
  const { settleReturnLine } = await import("@/lib/settleReturn");
  return settleReturnLine(product, { id: ORDER.id });
}

describe("settleReturnLine marks exactly the row it paid for", () => {
  it("flips the refund lane's row by id, never by variant", async () => {
    await settle(CALLER_LINE);

    expect(whereClauses).toHaveLength(1);
    const columns = columnsIn(whereClauses[0]);
    expect(columns).toEqual(["id"]);
    expect(columns).not.toContain("variant_id");
  });

  it("flips the credit lane's row by id, never by variant", async () => {
    dbLine.value = { ...dbLine.value!, credit: true };

    await settle({ ...CALLER_LINE, credit: true });

    expect(giftCards).toHaveLength(1); // the payout really happened
    expect(whereClauses).toHaveLength(1);
    expect(columnsIn(whereClauses[0])).toEqual(["id"]);
  });

  it("reports the row it flipped, so a looping caller can skip it", async () => {
    const outcome = await settle(CALLER_LINE);

    expect(outcome).toEqual({
      settled: true,
      lane: "refund",
      lineIds: ["4242"],
    });
  });
});

describe("settleReturnLine's refund lane takes its money from the row", () => {
  it("refunds the stored price less the return leg, not the caller's price", async () => {
    // 40.00 stored − 5 return leg = 35. The caller asked for 100000.
    await settle(CALLER_LINE);

    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].amount).toBe(35);
  });

  it("names the return, line item and transaction from the row", async () => {
    await settle(CALLER_LINE);

    expect(refundCalls[0]).toMatchObject({
      returnId: "row-return",
      returnLineItemId: "row-rli",
      transactionId: "row-txn",
    });
  });

  it("still refunds the undocked price for a self-booked return", async () => {
    // The control: the €5 rule and its self-booked zeroing are unchanged —
    // only where the price is read from moved.
    ORDER.returnMethod = "SELF";

    await settle(CALLER_LINE);

    expect(refundCalls[0].amount).toBe(40);
  });
});

describe("settleReturnLine closes the return it actually settled", () => {
  // The refund is booked against the ROW's return, so closing the CALLER's is
  // not merely untidy: if the two ever disagree, the return we just refunded
  // stays OPEN forever while some other return is closed — and the auto-approve
  // gate reads that other one as `shopify-not-open` and silently withholds a
  // different customer's refund. Nothing double-pays; someone simply never
  // gets paid.

  it("closes the row's return in the refund lane, not the caller's", async () => {
    await settle(CALLER_LINE);

    expect(refundCalls[0].returnId).toBe("row-return");
    expect(closedReturns).toEqual(["row-return"]);
  });

  it("closes the row's return in the credit lane, not the caller's", async () => {
    dbLine.value = { ...dbLine.value!, credit: true };

    await settle({ ...CALLER_LINE, credit: true });

    expect(giftCards).toHaveLength(1);
    expect(closedReturns).toEqual(["row-return"]);
  });

  it("books the store-credit refund against the row's return and line item", async () => {
    // The comment above this call already said to read the line item from the
    // row "for exactly the reason it is untrusted here — it names what Shopify
    // refunds". The line item obeyed it; the return id did not.
    dbLine.value = { ...dbLine.value!, credit: true };

    await settle({ ...CALLER_LINE, credit: true });

    expect(storeCreditRefundCalls).toEqual([
      { returnId: "row-return", returnLineItemId: "row-rli" },
    ]);
  });
});
