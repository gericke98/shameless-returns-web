import { beforeEach, describe, expect, it, vi } from "vitest";

// A line whose stored `transaction_id` is unusable must be REFUSED, not sent to
// Shopify as an empty string.
//
// `createReturn` now stores null when an order has no settled payment to refund
// against (see `lib/refundTransaction.ts`). Before this guard, null became `""`
// on the way into `createRefund`, and the failure surfaced as a Shopify
// userError deep in the money path — which is precisely where nothing was
// watching: the cron recorded `settle-refused:refund-failed`, returned 200, and
// #311882 went unpaid for five days.

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
const refundCalls: any[] = [];
const closedReturns: string[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getOrderByIdFresh: async () => ORDER,
  getOrderTotal: async () => ({ id: ORDER.id, customer: { id: "c1" } }),
  processGiftCardReturn: async () => ({ success: true, data: { id: "gc1" } }),
  createRefund: async (
    returnId: string,
    returnLineItemId: string,
    transactionId: string,
    amount: number
  ) => {
    refundCalls.push({ returnId, returnLineItemId, transactionId, amount });
    return { success: true };
  },
  createStoreCreditRefund: async () => ({ success: true }),
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

const alerts: Array<{ subject: string; body: string }> = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

const writes: unknown[] = [];
const dbLine = { value: null as null | Record<string, unknown> };
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: (clause: unknown) => {
      writes.push(clause);
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

beforeEach(() => {
  refundCalls.length = 0;
  closedReturns.length = 0;
  writes.length = 0;
  alerts.length = 0;
  for (const key of Object.keys(ORDER)) delete ORDER[key];
  Object.assign(ORDER, {
    id: "13292837830982",
    orderNumber: "#311882",
    shippingCountry: "Spain",
    shippingZip: "28001",
    returnMethod: "CORREOS",
    products: [],
  });
  dbLine.value = {
    id: 1078,
    orderId: "13292837830982",
    variant_id: "55415860068678",
    price: "52.25",
    credit: false,
    action: "DEVOLUCIÓN",
    refunded: false,
    return_id: "gid://shopify/Return/58161463622",
    return_line_item_id: "gid://shopify/ReturnLineItem/90336002374",
    transaction_id: null,
  };
});

async function settle() {
  const { settleReturnLine } = await import("@/lib/settleReturn");
  return settleReturnLine(
    { variant_id: "55415860068678", return_id: "r", return_line_item_id: "rli" },
    { id: ORDER.id }
  );
}

describe("settleReturnLine refuses a line with no refundable transaction", () => {
  it("does not call Shopify at all", async () => {
    await settle();

    expect(refundCalls).toHaveLength(0);
  });

  it("reports a reason naming the missing transaction", async () => {
    const outcome = await settle();

    expect(outcome.settled).toBe(false);
    expect(outcome.settled === false && outcome.reason).toBe("no-refund-transaction");
  });

  it("never marks the line refunded or closes the return", async () => {
    await settle();

    // The customer has NOT been paid; writing either would hide that forever.
    expect(writes).toHaveLength(0);
    expect(closedReturns).toHaveLength(0);
  });

  it("treats an empty-string transaction id the same as a missing one", async () => {
    dbLine.value = { ...dbLine.value!, transaction_id: "   " };

    const outcome = await settle();

    expect(outcome.settled).toBe(false);
    expect(refundCalls).toHaveLength(0);
  });

  it("still settles normally when a real transaction is stored", async () => {
    dbLine.value = {
      ...dbLine.value!,
      transaction_id: "gid://shopify/OrderTransaction/14925389824326",
    };

    const outcome = await settle();

    expect(outcome.settled).toBe(true);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].transactionId).toBe(
      "gid://shopify/OrderTransaction/14925389824326"
    );
  });
});
