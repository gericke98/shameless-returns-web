import { beforeEach, describe, expect, it, vi } from "vitest";

// The reservation runs AFTER the customer has paid, and often after a courier
// collection or a Correos label already exists. So it may never throw: order
// #310972 was lost because a post-booking step threw and the caller reverted a
// return whose real-world half could not be reverted.
//
// A failed stock hold is a merchandising problem to chase. It is not a reason
// to fail a return.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
  id: "13161229386054",
  orderNumber: "#310756",
  email: "customer@example.com",
  exchangeReservationId: null as string | null,
  products: [
    {
      variant_id: "111",
      new_variant_id: "aaa" as string | null,
      action: "CAMBIO",
      quantity: 1,
      confirmed: true,
      refunded: false,
    },
  ],
};

const state = { order: { ...ORDER } };
const updates: any[] = [];

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: unknown) => {
      updates.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
    query: { orders: { findFirst: async () => state.order } },
  };
  return { default: chain };
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  state.order = { ...ORDER, products: [...ORDER.products] };
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "shpat_test";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://example.myshopify.com";
  vi.stubGlobal("fetch", fetchMock);
});

const ok = (draft: any) => ({
  json: async () => ({
    data: { draftOrderCreate: { draftOrder: draft, userErrors: [] } },
  }),
});

describe("reserveExchangeStock", () => {
  it("holds the replacement and records the draft against the order", async () => {
    fetchMock.mockResolvedValue(
      ok({
        id: "gid://shopify/DraftOrder/1",
        name: "#D9",
        reserveInventoryUntil: "2026-08-29T12:00:00.000Z",
      })
    );
    const { reserveExchangeStock } = await import("@/actions/exchangeReservation");

    await reserveExchangeStock("13161229386054");

    expect(updates).toContainEqual({
      exchangeReservationId: "gid://shopify/DraftOrder/1",
    });
  });

  it("does not place a second hold when one already exists", async () => {
    // A Stripe webhook retry must not freeze the stock twice.
    state.order = { ...state.order, exchangeReservationId: "gid://shopify/DraftOrder/1" };
    const { reserveExchangeStock } = await import("@/actions/exchangeReservation");

    await reserveExchangeStock("13161229386054");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing at all for an order with no exchange", async () => {
    state.order = {
      ...state.order,
      products: [
        { variant_id: "111", new_variant_id: null, action: "DEVOLUCIÓN", quantity: 1, confirmed: true, refunded: false },
      ],
    };
    const { reserveExchangeStock } = await import("@/actions/exchangeReservation");

    await reserveExchangeStock("13161229386054");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives Shopify refusing the hold — most likely already out of stock", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        data: {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [{ field: ["lineItems"], message: "Insufficient inventory" }],
          },
        },
      }),
    });
    const { reserveExchangeStock } = await import("@/actions/exchangeReservation");

    await expect(reserveExchangeStock("13161229386054")).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  it("survives the network being down", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const { reserveExchangeStock } = await import("@/actions/exchangeReservation");

    await expect(reserveExchangeStock("13161229386054")).resolves.toBeUndefined();
  });
});

describe("releaseExchangeReservation", () => {
  it("reports success when there was never a hold", async () => {
    const { releaseExchangeReservation } = await import("@/actions/exchangeReservation");

    await expect(releaseExchangeReservation("13161229386054")).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes the draft and clears the pointer", async () => {
    state.order = { ...state.order, exchangeReservationId: "gid://shopify/DraftOrder/1" };
    fetchMock.mockResolvedValue({
      json: async () => ({
        data: { draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/1", userErrors: [] } },
      }),
    });
    const { releaseExchangeReservation } = await import("@/actions/exchangeReservation");

    await expect(releaseExchangeReservation("13161229386054")).resolves.toBe(true);
    expect(updates).toContainEqual({ exchangeReservationId: null });
  });

  it("KEEPS the pointer when the delete fails", async () => {
    // The column is the only handle on a hold that is still holding stock.
    // Clearing it strands those units until the reservation lapses on its own.
    state.order = { ...state.order, exchangeReservationId: "gid://shopify/DraftOrder/1" };
    fetchMock.mockResolvedValue({
      json: async () => ({
        data: { draftOrderDelete: { userErrors: [{ message: "not found" }] } },
      }),
    });
    const { releaseExchangeReservation } = await import("@/actions/exchangeReservation");

    await expect(releaseExchangeReservation("13161229386054")).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });
});
