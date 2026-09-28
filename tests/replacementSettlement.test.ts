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
      if (RELEASE_THROWS && payload?.refunded === false) throw new Error("db down");
      sets.push(payload);
      if (payload?.refunded === true) sequence.push("mark");
      return chain;
    },
    // `where` must be both awaitable (plain updates) and chainable into
    // `.returning()` (the atomic claim).
    where: () => {
      const p: any = Promise.resolve();
      p.returning = async () => (CLAIM ? [{ id: dbLine.value?.id }] : []);
      return p;
    },
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
let CLAIM = true; // does the atomic claim win the row?
let RELEASE_THROWS = false; // does releasing the claim blow up?
let ROOT_NOTES: any = { success: true, notes: [] }; // refunds already on the root
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
  getOrderRefundNotes: async (id: string) => { sequence.push(`notes:${id}`); return ROOT_NOTES; },
  refundOnOrder: async (...args: any[]) => { sequence.push("money"); rootRefunds.push(args); return ROOT_REFUND; },
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
  CLAIM = true;
  RELEASE_THROWS = false;
  ROOT_NOTES = { success: true, notes: [] };
  ORDERS["A"] = { id: "A", orderNumber: "#311749", exchangeOf: null, stripePaymentIntent: null, returnMethod: "CORREOS",
    products: [{ variant_id: "old", productId: "P1", new_variant_id: "gid://shopify/ProductVariant/54623384404294", action: "CAMBIO", confirmed: true, price: "47.03" }] };
  ORDERS["B"] = { id: "B", orderNumber: "#312061", exchangeOf: "A", returnMethod: "CORREOS", shippingCountry: "Spain", shippingZip: "28001", products: [] };
  dbLine.value = { id: 1154, orderId: "B", variant_id: "54623384404294", productId: "P1", price: "47.03", credit: false,
    action: "DEVOLUCIÓN", refunded: false, return_id: "gid://shopify/Return/R", return_line_item_id: "gid://shopify/ReturnLineItem/L",
    transaction_id: "gid://shopify/OrderTransaction/9" };
});

const settle = async () => (await import("@/lib/settleReturn")).settleReturnLine(
  { variant_id: "54623384404294", return_id: "r", return_line_item_id: "rli" }, { id: "B" });

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

  it("claims the row BEFORE the money, and books the goods after", async () => {
    await settle();
    expect(sequence).toEqual(["notes:A", "mark", "money", "book", "close"]);
    expect(bookings).toEqual(["gid://shopify/Return/R"]);
  });

  it("stays settled and alerts when booking the goods fails", async () => {
    BOOKING = { success: false, errors: ["x"] };
    const out = await settle();
    expect(out.settled).toBe(true);
    expect(sets.some((s) => s.refunded === true)).toBe(true);
    expect(alerts.some((a) => a.subject.includes("#312061"))).toBe(true);
    expect(alerts.find((a) => a.subject.includes("NOT BOOKED"))?.body).toContain(
      "never refund them by hand on the original order"
    );
  });

  it("releases the claim and books nothing when the root refund fails", async () => {
    ROOT_REFUND = { success: false, errors: ["no"] };
    const out = await settle();
    expect(out).toEqual({ settled: false, reason: "refund-failed" });
    // Claimed, then released: the row ends NOT refunded.
    expect(sets).toEqual([{ refunded: true }, { refunded: false }]);
    expect(bookings).toHaveLength(0);
  });

  it("pays nothing when a concurrent settlement already claimed the row", async () => {
    CLAIM = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await settle();
    errors.mockRestore();
    expect(out).toEqual({ settled: false, reason: "already-refunded" });
    expect(rootRefunds).toHaveLength(0);
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

describe("replacement lane — a hand refund on the root", () => {
  // #312061 was refunded by hand on the root. The replacement's Return stays
  // OPEN and `refunded` stays NULL, so the gate passes and the claim wins; only
  // the root's refund notes can tell us the customer was already paid.
  it("refuses before claiming when a root refund names the replacement without this line's marker", async () => {
    ROOT_NOTES = { success: true, notes: ["Refund for exchange #312061 — customer returned it"] };
    const out = await settle();
    expect(out).toEqual({ settled: false, reason: "root-has-unmarked-refund" });
    expect(sets).toHaveLength(0); // no claim issued
    expect(rootRefunds).toHaveLength(0); // no money
    expect(bookings).toHaveLength(0);
    const alert = alerts.find((a) => a.subject.includes("#312061"));
    expect(alert?.body).toContain("1154");
    expect(alert?.body).toContain("never refund them by hand on the original order");
  });

  it("leaves the marker replay path unchanged when the note carries this line's marker", async () => {
    ROOT_NOTES = { success: true, notes: ["[gid://shopify/ReturnLineItem/L] Return from replacement order #312061"] };
    ROOT_REFUND = { success: true, alreadyRefunded: true };
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(rootRefunds).toHaveLength(1);
    expect(alerts.some((a) => a.subject.includes("MAY ALREADY BE PAID"))).toBe(false);
  });

  it("proceeds when a sibling line of the same replacement was settled (different marker)", async () => {
    ROOT_NOTES = { success: true, notes: ["[gid://shopify/ReturnLineItem/999] Return from replacement order #312061"] };
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(rootRefunds).toHaveLength(1);
  });

  it("proceeds normally when a root refund mentions a DIFFERENT order number", async () => {
    ROOT_NOTES = { success: true, notes: ["Refund for #3120610 and #312060"] };
    const out = await settle();
    expect(out).toMatchObject({ settled: true, lane: "refund" });
    expect(rootRefunds).toHaveLength(1);
  });

  it("refuses, claiming nothing, when the root's refunds cannot be read", async () => {
    ROOT_NOTES = { success: false, errors: "boom" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await settle();
    errors.mockRestore();
    expect(out).toEqual({ settled: false, reason: "refund-failed" });
    expect(sets).toHaveLength(0);
    expect(rootRefunds).toHaveLength(0);
  });
});

describe("replacement lane — a claim that cannot be released", () => {
  it("returns claim-stuck and tells ops to clear the row by hand", async () => {
    ROOT_REFUND = { success: false, errors: ["no"] };
    RELEASE_THROWS = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await settle();
    errors.mockRestore();
    expect(out).toEqual({ settled: false, reason: "claim-stuck" });
    const alert = alerts.find((a) => a.subject.includes("CLAIM STUCK"));
    expect(alert?.body).toContain("Row marked refunded but customer NOT paid");
    expect(alert?.body).toContain("productsorder row 1154");
    expect(bookings).toHaveLength(0);
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
