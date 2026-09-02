import { beforeEach, describe, expect, it, vi } from "vitest";

// The return fee is collected in TWO places, and self-booking has to be
// subtracted from both.
//
//   1. `createStripeUrl` — the pre-payment point. Already correct.
//   2. settlement — `updateFinalOrder` declares `returnShippingFee` on the
//      Shopify return, and `validateReturn` deducts the leg from the refund or
//      the gift card.
//
// With only (1) fixed, a self-booked pure return is advertised as free, charged
// nothing up front, and shown an undocked refund figure — and then settlement
// quietly deducts the return leg anyway. The customer pays their own postage
// AND is docked for shipping we never did, receiving less than the number they
// were shown.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

// ── The order row settlement reads the lane from ────────────────────────────
const ORDER: Record<string, any> = {};

// ── validateReturn scaffolding ──────────────────────────────────────────────
const session = { value: { user: { role: "admin" } } as unknown };
vi.mock("next-auth", () => ({ getServerSession: async () => session.value }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const giftCards: number[] = [];
const refunds: number[] = [];

// ── updateFinalOrder scaffolding ────────────────────────────────────────────
const FULFILLMENT_GID = "gid://shopify/Fulfillment/1";
const TOTAL_ORDER = {
  id: "13192219558214",
  fulfillments: [
    { admin_graphql_api_id: FULFILLMENT_GID, line_items: [{ variant_id: 1 }] },
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
const LINE_ROWS = [
  { variant_id: "1", confirmed: false, return_id: null, action: "DEVOLUCIÓN", quantity: 1 },
];
const returnInputs: any[] = [];

// `getOrderById` is request-scoped React `cache()`d, and on the FREE path
// `decideMethod` primes it BEFORE `persistReturnMethod` writes the lane — so the
// cached snapshot still says `returnMethod: null` while the row says "SELF".
// Flipping this makes the two readers disagree exactly the way production does,
// which is the only way a test can tell which one `updateFinalOrder` actually
// calls. Default false, so every other test in this file is unaffected.
const cachedIsStale = { value: false };

vi.mock("@/db/queries", () => ({
  getOrderById: async () =>
    cachedIsStale.value ? { ...ORDER, returnMethod: null } : ORDER,
  getOrderByIdFresh: async () => ORDER,
  getProducts: async () => [],
  getOrderTotal: async () => ({ ...TOTAL_ORDER, customer: { id: "c1" } }),
  getOrderProductsById: async () => LINE_ROWS,
  getFulfillmentLineItems: async () => FULFILLMENT_LINE_ITEMS,
  createReturn: async (input: any) => {
    returnInputs.push(input);
    return {
      success: true as const,
      data: { id: "gid://shopify/Return/1", returnLineItems: [], transactionId: "t" },
    };
  },
  processGiftCardReturn: async (_c: string, value: number) => {
    giftCards.push(value);
    return { success: true };
  },
  createRefund: async (_r: string, _l: string, _t: string, amount: number) => {
    refunds.push(amount);
    return { success: true };
  },
  // The credit lane records the return on Shopify without moving money. It is
  // not what this file is about — see creditLaneSettlement.test.ts — but the
  // gift-card cases below go through it.
  createStoreCreditRefund: async () => ({ success: true }),
  noteStoreCreditOnOrder: async () => ({ success: true }),
  createOrder: async () => ({ success: true }),
  closeReturn: async () => ({ success: true }),
}));

// Return leg 6.50 for every weight, so the deduction is a single known number.
const BANDS = [{ maxGrams: 2147483647, returnFeeCents: 650, exchangeFeeCents: 1100 }];
vi.mock("@/db/fees", () => ({ getFeeTable: async () => ({ "*": BANDS }) }));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: async () => ({
    order: ORDER,
    catalogue: [],
    basket: { hasItems: true, netAmount: 50, grams: 500 },
  }),
}));
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async () => {},
  reserveExchangeStock: async () => {},
}));
vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));

const dbLine = { value: null as null | Record<string, unknown> };
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
    select: () => chain,
    from: () => Promise.resolve([]),
    query: {
      productsOrder: {
        findFirst: async () => dbLine.value,
        findMany: async () => LINE_ROWS,
      },
    },
  };
  return { default: chain };
});

async function settleLine(product: Record<string, any>) {
  const { validateReturn } = await import("@/actions/refund");
  await validateReturn(product, "any", { id: ORDER.id });
}

async function createTheShopifyReturn() {
  const { updateFinalOrder } = await import("@/actions/updateOrder");
  await updateFinalOrder(ORDER.id, false, false);
}

beforeEach(() => {
  giftCards.length = 0;
  refunds.length = 0;
  returnInputs.length = 0;
  session.value = { user: { role: "admin" } };
  for (const key of Object.keys(ORDER)) delete ORDER[key];
  Object.assign(ORDER, {
    id: "13192219558214",
    orderNumber: "#311174",
    shippingCountry: "Italy",
    shippingZip: "20121",
    returnMethod: null,
    products: [],
  });
  cachedIsStale.value = false;
  dbLine.value = {
    id: 7,
    orderId: "13192219558214",
    variant_id: "1",
    price: "50.00",
    credit: false,
    action: "DEVOLUCIÓN",
    refunded: false,
    return_id: "r1",
  };
});

describe("settling a self-booked return", () => {
  it("refunds the full price — the return leg was never charged", async () => {
    ORDER.returnMethod = "SELF";

    await settleLine({
      variant_id: "1",
      price: "50.00",
      return_id: "r1",
      return_line_item_id: "rli1",
      transaction_id: "t1",
    });

    expect(refunds).toEqual([50]);
  });

  it("still deducts the leg from a return we shipped ourselves", async () => {
    // The control half. Same order, same price, only the lane differs — so
    // together these two prove SELF actually changes the outcome rather than
    // the two lanes coincidentally agreeing.
    ORDER.returnMethod = "CORREOS";

    await settleLine({
      variant_id: "1",
      price: "50.00",
      return_id: "r1",
      return_line_item_id: "rli1",
      transaction_id: "t1",
    });

    expect(refunds).toEqual([45]);
  });

  it("mints a gift card on the undocked price", async () => {
    ORDER.returnMethod = "SELF";
    dbLine.value = { ...(dbLine.value as any), credit: true };

    await settleLine({ variant_id: "1", price: "50.00", credit: true, return_id: "r1" });

    expect(giftCards).toHaveLength(1);
    expect(giftCards[0]).toBeCloseTo(50 * 1.15, 6);
  });

  it("still docks the gift card of a return we shipped ourselves", async () => {
    ORDER.returnMethod = "AMPHORA";
    dbLine.value = { ...(dbLine.value as any), credit: true };

    await settleLine({ variant_id: "1", price: "50.00", credit: true, return_id: "r1" });

    expect(giftCards).toHaveLength(1);
    expect(giftCards[0]).toBeCloseTo((50 - 6.5) * 1.15, 6);
  });

  it("declares a zero return-shipping fee on the Shopify return", async () => {
    // The other half of the same deduction: Shopify applies
    // `returnShippingFee` when the return is refunded, so leaving it at the
    // full leg docks the customer there instead.
    ORDER.returnMethod = "SELF";

    await createTheShopifyReturn();

    expect(returnInputs).toHaveLength(1);
    expect(returnInputs[0].returnShippingFee).toEqual({
      amount: { amount: "0.00", currencyCode: "EUR" },
    });
  });

  it("reads the lane FRESH, not through the request cache", async () => {
    // Regression guard for the fix, not for the feature.
    //
    // `updateFinalOrder` must call `getOrderByIdFresh`. Every other test here
    // mocks both readers to the same object, so swapping the call back to the
    // cached `getOrderById` would leave them all green while silently
    // re-introducing the settlement double-charge for the headline case: a free
    // self-booked return on the free path, where `decideMethod` has already
    // primed the cache with the pre-persist snapshot.
    //
    // Here the two readers disagree the way they do in production — cached says
    // null, the row says SELF. Reading the wrong one declares the full 6.50.
    cachedIsStale.value = true;
    ORDER.returnMethod = "SELF";

    await createTheShopifyReturn();

    expect(returnInputs).toHaveLength(1);
    expect(returnInputs[0].returnShippingFee).toEqual({
      amount: { amount: "0.00", currencyCode: "EUR" },
    });
  });

  it("still declares the full leg for a return we shipped ourselves", async () => {
    ORDER.returnMethod = "CORREOS";

    await createTheShopifyReturn();

    expect(returnInputs).toHaveLength(1);
    expect(returnInputs[0].returnShippingFee).toEqual({
      amount: { amount: "6.50", currencyCode: "EUR" },
    });
  });
});
