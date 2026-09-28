import { beforeEach, describe, expect, it, vi } from "vitest";

// Settling a return from a REPLACEMENT order (one we created during an
// exchange). Its own payment is a €0.01 placeholder, so the money must go back
// on the ROOT order while the goods are booked back on the replacement. Once
// money has moved the row must be marked refunded before anything else can
// fail — otherwise the next morning's auto-approve cron pays again.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

const BANDS = [{ maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 850 }];
vi.mock("@/db/fees", () => ({ getFeeTable: async () => ({ "*": BANDS }) }));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: async () => ({
    order: ORDERS["B"],
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

const dbLine = { value: null as null | Record<string, unknown> };

const sets: any[] = [];
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (payload: any) => {
      sets.push(payload);
      if (payload?.refunded === true) sequence.push("mark");
      return chain;
    },
    where: () => Promise.resolve(),
    select: () => chain,
    from: () => Promise.resolve([]),
    query: { productsOrder: { findFirst: async () => dbLine.value, findMany: async () => [] } },
  };
  return { default: chain };
});

const rootRefunds: any[] = [];
const singleRefunds: any[] = [];
const bookings: string[] = [];
const sequence: string[] = []; // "mark" | "book" | "close", in call order
let ALLOW_SINGLE = false;
const closed: string[] = [];
let ROOT_REFUND: any = { success: true, alreadyRefunded: false };
let BOOKING: any = { success: true };
const ORDERS: Record<string, any> = {};

vi.mock("@/db/queries", () => ({
  getOrderById: async (id: string) => ORDERS[id],
  getOrderByIdFresh: async (id: string) => ORDERS[id],
  getOrderTotal: async () => ({ customer: { id: "c1" } }),
  processGiftCardReturn: async () => ({ success: true, data: { id: "gc1" } }),
  createRefund: async (...args: any[]) => {
    if (!ALLOW_SINGLE) throw new Error("must not refund on the replacement order");
    singleRefunds.push(args);
    return { success: true };
  },
  refundOnOrder: async (...args: any[]) => { rootRefunds.push(args); return ROOT_REFUND; },
  createStoreCreditRefund: async (returnId: string) => { sequence.push("book"); bookings.push(returnId); return BOOKING; },
  noteStoreCreditOnOrder: async () => ({ success: true }),
  createOrder: async () => ({ success: true }),
  closeReturn: async (id: string) => { sequence.push("close"); closed.push(id); return { success: true }; },
}));

beforeEach(() => {
  for (const a of [rootRefunds, singleRefunds, bookings, closed, sequence, sets, alerts]) a.length = 0;
  ROOT_REFUND = { success: true, alreadyRefunded: false };
  BOOKING = { success: true };
  ALLOW_SINGLE = false;
  ORDERS["A"] = { id: "A", orderNumber: "#311749", exchangeOf: null, stripePaymentIntent: null, returnMethod: "CORREOS",
    products: [{ variant_id: "old", productId: "P1", new_variant_id: "gid://shopify/ProductVariant/V", action: "CAMBIO", confirmed: true, price: "47.03" }] };
  ORDERS["B"] = { id: "B", orderNumber: "#312061", exchangeOf: "A", returnMethod: "CORREOS", shippingCountry: "Spain", shippingZip: "28001", products: [] };
  dbLine.value = { id: 1154, orderId: "B", variant_id: "V", productId: "P1", price: "47.03", credit: false,
    action: "DEVOLUCIÓN", refunded: false, return_id: "gid://shopify/Return/R", return_line_item_id: "gid://shopify/ReturnLineItem/L",
    transaction_id: "gid://shopify/OrderTransaction/9" };
});

const settle = async () => (await import("@/lib/settleReturn")).settleReturnLine(
  { variant_id: "V", return_id: "r", return_line_item_id: "rli" }, { id: "B" });

describe("refund lane on a replacement order", () => {
  it("moves the money on the ROOT order, price minus the return leg", async () => {
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(rootRefunds).toHaveLength(1);
    const [orderId, tx, amount, marker] = rootRefunds[0];
    expect(orderId).toBe("A");
    expect(tx).toBe("gid://shopify/OrderTransaction/9");
    expect(amount).toBeCloseTo(42.03, 2);
    expect(marker).toBe("gid://shopify/ReturnLineItem/L");
  });

  it("marks the row refunded BEFORE booking the goods", async () => {
    await settle();
    expect(sequence).toEqual(["mark", "book", "close"]);
    expect(bookings).toEqual(["gid://shopify/Return/R"]);
  });

  it("stays settled and alerts when booking the goods fails", async () => {
    BOOKING = { success: false, errors: ["x"] };
    const out = await settle();
    expect(out.settled).toBe(true);
    expect(sets.some((s) => s.refunded === true)).toBe(true);
    expect(alerts.some((a) => a.subject.includes("#312061"))).toBe(true);
  });

  it("marks nothing when the root refund fails", async () => {
    ROOT_REFUND = { success: false, errors: ["no"] };
    const out = await settle();
    expect(out).toEqual({ settled: false, reason: "refund-failed" });
    expect(sets).toHaveLength(0);
    expect(bookings).toHaveLength(0);
  });

  it("a replay after the money moved pays nothing (marker path)", async () => {
    ROOT_REFUND = { success: true, alreadyRefunded: true };
    const out = await settle();
    expect(out.settled).toBe(true);
    expect(sets.some((s) => s.refunded === true)).toBe(true);
  });

  it("alerts about a possible top-up on a product swap with a Stripe payment", async () => {
    ORDERS["A"].stripePaymentIntent = "pi_123";
    dbLine.value!.productId = "P2"; // replacement is a different product
    await settle();
    expect(alerts.some((a) => a.body.includes("pi_123"))).toBe(true);
  });

  it("does not alert a top-up on a size swap", async () => {
    ORDERS["A"].stripePaymentIntent = "pi_123";
    await settle();
    expect(alerts.some((a) => a.body.includes("pi_123"))).toBe(false);
  });

  it("leaves ordinary orders on the existing single-order path", async () => {
    ORDERS["B"].exchangeOf = null;
    ALLOW_SINGLE = true;
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(rootRefunds).toHaveLength(0);
    expect(singleRefunds).toHaveLength(1);
  });

  it("refuses, moving nothing, when the root walk throws (exchange_of cycle)", async () => {
    ORDERS["A"].exchangeOf = "B"; // A -> B -> A
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await settle();
    expect(out).toEqual({ settled: false, reason: "refund-failed" });
    expect(rootRefunds).toHaveLength(0);
    expect(sets).toHaveLength(0);
    expect(bookings).toHaveLength(0);
    expect(errors.mock.calls.some((c) => String(c.join(" ")).includes("B"))).toBe(true);
    errors.mockRestore();
  });

  it("refuses, moving nothing, when the row has no return line item to mark the refund with", async () => {
    dbLine.value!.return_line_item_id = null;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await settle();
    errors.mockRestore();
    expect(out).toEqual({ settled: false, reason: "refund-failed" });
    expect(rootRefunds).toHaveLength(0);
    expect(sets).toHaveLength(0);
  });

  it("a top-up alert that throws never un-settles a paid refund", async () => {
    ORDERS["A"].stripePaymentIntent = "pi_123";
    dbLine.value!.productId = "P2";
    // The original's products are unreadable: wasProductSwap would throw.
    ORDERS["A"].products = { not: "an array" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await settle();
    errors.mockRestore();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(sets.some((s) => s.refunded === true)).toBe(true);
  });
});

describe("credit lane on a replacement order", () => {
  it("alerts a possible top-up after marking the row", async () => {
    dbLine.value!.credit = true;
    dbLine.value!.productId = "P2";
    ORDERS["A"].stripePaymentIntent = "pi_123";
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "credit" });
    expect(sets.some((s) => s.refunded === true)).toBe(true);
    expect(alerts.some((a) => a.body.includes("pi_123") && a.body.includes("store credit"))).toBe(true);
  });
});
