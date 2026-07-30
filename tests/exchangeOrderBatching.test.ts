import { beforeEach, describe, expect, it, vi } from "vitest";

// An order with two exchanged garments produced TWO Shopify orders.
//
// `validateReturn` is called once per dashboard ROW, and its CAMBIO branch
// called `createOrder(order, product)` with a single-element lineItems array.
// Two rows, two clicks, two orders — two parcels to the same address, two
// shipping charges, two deliveries for one customer to wait on.
//
// The rows are separate in the UI; the shipment is not.

vi.mock("next-auth", () => ({ getServerSession: async () => ({ user: { role: "admin" } }) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

const createOrderCalls: any[][] = [];
const closeReturnCalls: string[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ({ id: "1", shippingCountry: "ES", products: [] }),
  getProducts: async () => [],
  getOrderTotal: async () => ({ id: "1", customer: { id: "c1" } }),
  processGiftCardReturn: async () => ({ success: true }),
  createRefund: async () => ({ success: true }),
  createOrder: async (_order: any, products: any[]) => {
    createOrderCalls.push(products);
    return { success: true, data: { id: "gid://shopify/Order/999" } };
  },
  closeReturn: async (id: string) => {
    closeReturnCalls.push(id);
    return { success: true };
  },
}));

// Two CAMBIO lines on one order, sharing one batched return.
const LINES = [
  {
    id: 1,
    orderId: "1",
    variant_id: "111",
    new_variant_id: "aaa",
    action: "CAMBIO",
    confirmed: true,
    refunded: false,
    credit: false,
    price: "29.00",
    return_id: "gid://shopify/Return/1",
  },
  {
    id: 2,
    orderId: "1",
    variant_id: "222",
    new_variant_id: "bbb",
    action: "CAMBIO",
    confirmed: true,
    refunded: false,
    credit: false,
    price: "45.00",
    return_id: "gid://shopify/Return/1",
  },
];

const state = { lines: [] as any[], lookupVariant: "111" };
const updates: any[] = [];

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: unknown) => {
      updates.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
    query: {
      productsOrder: {
        // Faithful to the real query: scoped by variant, NOT by refunded —
        // otherwise the "already settled" case short-circuits on a missing row
        // and never reaches the guard it is meant to exercise.
        findFirst: async () =>
          state.lines.find((l) => l.variant_id === state.lookupVariant) ?? null,
        findMany: async () => state.lines,
      },
    },
  };
  return { default: chain };
});

vi.mock("@/db/fees", () => ({ getFeeTable: async () => [] }));

beforeEach(() => {
  createOrderCalls.length = 0;
  closeReturnCalls.length = 0;
  updates.length = 0;
  state.lines = LINES.map((l) => ({ ...l }));
  state.lookupVariant = "111";
});

async function validate(variantId: string) {
  state.lookupVariant = variantId;
  const { validateReturn } = await import("@/actions/refund");
  await validateReturn(
    { variant_id: variantId, action: "CAMBIO", return_id: "gid://shopify/Return/1" },
    "Entregado",
    { id: "1", orderNumber: "#310756" }
  );
}

describe("validateReturn — one exchange order per submission", () => {
  it("creates ONE Shopify order carrying BOTH replacement garments", async () => {
    await validate("111");

    expect(createOrderCalls).toHaveLength(1);
    expect(createOrderCalls[0].map((p: any) => p.new_variant_id)).toEqual([
      "aaa",
      "bbb",
    ]);
  });

  it("settles every exchange line, so the sibling row is already done", async () => {
    await validate("111");

    // One update covering both rows — the second click finds nothing pending.
    expect(updates).toContainEqual({ refunded: true });
  });

  it("closes the shared return once, not once per line", async () => {
    await validate("111");

    // Batched lines share a return_id; closing per line would call returnClose
    // twice on the same return.
    expect(closeReturnCalls).toEqual(["gid://shopify/Return/1"]);
  });

  it("does not create a second order when the lines are already settled", async () => {
    // A replayed click — the row exists and is found, but is already refunded.
    // Without this guard the same exchange mints a second parcel.
    state.lines = LINES.map((l) => ({ ...l, refunded: true }));
    await validate("111");

    expect(createOrderCalls).toHaveLength(0);
  });

  it("settles the whole exchange from EITHER row", async () => {
    // The admin may click the second garment's row first; the outcome must be
    // the same single order.
    await validate("222");

    expect(createOrderCalls).toHaveLength(1);
    expect(createOrderCalls[0].map((p: any) => p.new_variant_id)).toEqual([
      "aaa",
      "bbb",
    ]);
  });

  it("skips a CAMBIO line whose replacement variant was never recorded", async () => {
    state.lines = [
      { ...LINES[0] },
      { ...LINES[1], new_variant_id: null },
    ];
    await validate("111");

    // Sending variantId: null would fail the whole orderCreate, costing the
    // customer the garment we COULD ship.
    expect(createOrderCalls[0]).toHaveLength(1);
    expect(createOrderCalls[0][0].new_variant_id).toBe("aaa");
  });
});
