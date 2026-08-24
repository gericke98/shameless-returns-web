import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { productsOrder } from "@/db/schema";

// `processGiftCardReturn` writes the new card's id back onto the line that
// earned it. It used to scope that write by `variant_id` alone — which is not
// an identity. Every customer who ever returned the same garment shares that
// value, so one mint stamped its id across all of their rows.
//
// Settling #311449 (Borja Bueno, 2026-08-24) wrote his card id onto #310927
// (Marcos G. Merino) — a different customer, a settled MONEY refund, same
// crewneck. At the time this was found, 30 of the 150 stamped rows in
// production were sharing an id with an unrelated order.
//
// This has to be asserted against the `where` the query actually builds. A
// test that only checks the gift card's value and the row it meant to hit
// passes just as happily while 149 other rows are overwritten.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const setCalls: Array<Record<string, any>> = [];
const whereCalls: any[] = [];

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      setCalls.push(values);
      return chain;
    },
    where: (condition: any) => {
      whereCalls.push(condition);
      return Promise.resolve();
    },
  };
  return { default: chain };
});

const GIFT_CARD_GID = "gid://shopify/GiftCard/1310634049862";

global.fetch = (async () => ({
  json: async () => ({
    data: {
      giftCardCreate: { giftCard: { id: GIFT_CARD_GID }, userErrors: [] },
    },
  }),
})) as any;

beforeEach(() => {
  setCalls.length = 0;
  whereCalls.length = 0;
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.example.com";
});

describe("stamping the gift card onto the line", () => {
  it("scopes the write to one order's line, not to every order sharing the variant", async () => {
    const { processGiftCardReturn } = await import("@/db/queries");

    await processGiftCardReturn("c1", 37.41, "55865099551046", "13253700485446");

    const stamp = setCalls.findIndex((c) => "gift_card_id" in c);
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(setCalls[stamp]).toEqual({ gift_card_id: GIFT_CARD_GID });
    expect(whereCalls[stamp]).toEqual(
      and(
        eq(productsOrder.orderId, "13253700485446"),
        eq(productsOrder.variant_id, "55865099551046")
      )
    );
  });

  it("does not scope by variant alone", async () => {
    // Spelled out separately because it is the exact regression: a `where`
    // naming only the variant matches another customer's row.
    const { processGiftCardReturn } = await import("@/db/queries");

    await processGiftCardReturn("c1", 37.41, "55865099551046", "13253700485446");

    const stamp = setCalls.findIndex((c) => "gift_card_id" in c);
    expect(whereCalls[stamp]).not.toEqual(
      eq(productsOrder.variant_id, "55865099551046")
    );
  });
});
