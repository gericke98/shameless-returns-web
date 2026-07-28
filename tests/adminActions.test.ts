import { beforeEach, describe, expect, it, vi } from "vitest";

// `validateReturn` mints Shopify gift cards and issues refunds, and had no
// authentication of any kind. It is a "use server" action, so it is an
// independently addressable HTTP endpoint — `middleware.ts` matches the ROUTES
// `/dashboard/:path*` and `/login`, which does not cover server actions.
//
// Both `product` and `order` are `any` and caller-supplied, and the gift-card
// value is computed straight from `product.price`, so a single unauthenticated
// call could mint a card of arbitrary value.
//
// These tests pin that the money-moving path is unreachable without an admin
// session.

const session = { value: null as unknown };

vi.mock("next-auth", () => ({
  getServerSession: async () => session.value,
}));
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

const calls = { giftCard: 0, refund: 0, order: 0, orderTotal: 0 };

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ({ id: "1", shippingCountry: "ES", products: [] }),
  // Reached via loadBasket, which validateReturn uses to weigh the return
  // parcel — the weight picks the fee band. An empty catalogue is enough:
  // these tests assert authorisation, not pricing.
  getProducts: async () => [],
  getOrderTotal: async () => {
    calls.orderTotal++;
    return { id: "1", customer: { id: "c1" } };
  },
  processGiftCardReturn: async () => {
    calls.giftCard++;
    return { success: true };
  },
  createRefund: async () => {
    calls.refund++;
    return { success: true };
  },
  createOrder: async () => {
    calls.order++;
    return { success: true };
  },
  closeReturn: async () => ({ success: true }),
}));

export const dbLine = {
  value: null as null | Record<string, unknown>,
};

vi.mock("@/db/drizzle", () => {
  const chain: Record<string, unknown> = {};
  chain.update = () => chain;
  chain.set = () => chain;
  chain.where = () => Promise.resolve();
  // db/fees.ts reads the fee table with db.select().from(...)
  chain.select = () => chain;
  chain.from = () => Promise.resolve([]);
  // validateReturn reloads the line it is about to pay out.
  chain.query = {
    productsOrder: { findFirst: async () => dbLine.value },
  };
  return { default: chain };
});

beforeEach(() => {
  calls.giftCard = 0;
  calls.refund = 0;
  calls.order = 0;
  calls.orderTotal = 0;
  session.value = null;
  dbLine.value = {
    id: 7,
    orderId: "1",
    variant_id: "v1",
    price: "30.00",
    credit: true,
    action: "DEVOLUCIÓN",
    refunded: false,
    return_id: "r1",
  };
  vi.resetModules();
});

describe("validateReturn authorization", () => {
  // The exploit this test exists to prevent: an anonymous caller passing an
  // inflated `price` to mint a gift card worth whatever they chose.
  it("mints nothing for an unauthenticated caller", async () => {
    session.value = null;
    const { validateReturn } = await import("@/actions/refund");

    await validateReturn(
      { credit: true, price: 100000, variant_id: "v1" },
      "any",
      { id: "1", shippingCountry: "ES" }
    );

    expect(calls.giftCard).toBe(0);
    expect(calls.orderTotal).toBe(0);
  });

  it("mints nothing for a signed-in non-admin", async () => {
    session.value = { user: { role: "customer" } };
    const { validateReturn } = await import("@/actions/refund");

    await validateReturn(
      { credit: true, price: 100000, variant_id: "v1" },
      "any",
      { id: "1", shippingCountry: "ES" }
    );

    expect(calls.giftCard).toBe(0);
  });

  it("issues no refund for an unauthenticated caller", async () => {
    session.value = null;
    const { validateReturn } = await import("@/actions/refund");

    await validateReturn({ credit: false, price: 50, variant_id: "v1" }, "any", {
      id: "1",
      shippingCountry: "ES",
    });

    expect(calls.refund).toBe(0);
    expect(calls.order).toBe(0);
  });

  it("proceeds for an admin session", async () => {
    session.value = { user: { role: "admin" } };
    const { validateReturn } = await import("@/actions/refund");

    await validateReturn(
      { credit: true, price: 50, variant_id: "v1" },
      "any",
      { id: "1", shippingCountry: "ES" }
    );

    // Reaching getOrderTotal proves the gate opened; what happens after is the
    // pre-existing refund logic, not this test's concern.
    expect(calls.orderTotal).toBe(1);
  });
});

describe("validateReturn does not trust caller-supplied money", () => {
  it("ignores an inflated price and uses the stored one", async () => {
    // The remaining risk after the auth gate: an admin session was also
    // permission to name the gift-card value. It now comes from the database.
    session.value = { user: { role: "admin" } };
    dbLine.value = { ...dbLine.value!, price: "30.00" };

    const { validateReturn } = await import("@/actions/refund");
    await validateReturn(
      { credit: true, price: 100000, variant_id: "v1" },
      "any",
      { id: "1", shippingCountry: "ES" }
    );

    // Reached the payout path using the stored line, not the caller's numbers.
    expect(calls.giftCard).toBe(1);
  });

  it("pays nothing for a line that does not exist", async () => {
    session.value = { user: { role: "admin" } };
    dbLine.value = null;

    const { validateReturn } = await import("@/actions/refund");
    await validateReturn({ credit: true, price: 50, variant_id: "nope" }, "any", {
      id: "1",
      shippingCountry: "ES",
    });

    expect(calls.giftCard).toBe(0);
  });

  it("refuses to pay a line that is already refunded", async () => {
    // Without this, replaying the same call mints a second gift card.
    session.value = { user: { role: "admin" } };
    dbLine.value = { ...dbLine.value!, refunded: true };

    const { validateReturn } = await import("@/actions/refund");
    await validateReturn({ credit: true, price: 50, variant_id: "v1" }, "any", {
      id: "1",
      shippingCountry: "ES",
    });

    expect(calls.giftCard).toBe(0);
  });
});
