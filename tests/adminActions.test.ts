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

vi.mock("@/db/drizzle", () => {
  const chain: Record<string, unknown> = {};
  chain.update = () => chain;
  chain.set = () => chain;
  chain.where = () => Promise.resolve();
  // db/fees.ts reads the fee table with db.select().from(...)
  chain.select = () => chain;
  chain.from = () => Promise.resolve([]);
  return { default: chain };
});

describe("validateReturn authorization", () => {
  beforeEach(() => {
    calls.giftCard = 0;
    calls.refund = 0;
    calls.order = 0;
    calls.orderTotal = 0;
    session.value = null;
    vi.resetModules();
  });

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
