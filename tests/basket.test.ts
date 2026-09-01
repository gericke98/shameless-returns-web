import { describe, expect, it } from "vitest";
import { FALLBACK_ITEM_GRAMS, valueBasket } from "@/lib/basket";
import type { OrderItem, Product } from "@/types";

const vgid = (n: string) => `gid://shopify/ProductVariant/${n}`;

function product(id: string, variants: { id: string; price: string }[]): Product {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `P${id}`,
    handle: `p${id}`,
    description: "",
    images: { edges: [] },
    image: { src: "" },
    variants: {
      edges: variants.map((v) => ({
        node: {
          id: vgid(v.id),
          price: v.price,
          title: v.id,
          inventoryQuantity: 5,
          grams: 400,
        },
      })),
    },
  };
}

const CATALOGUE = [
  product("15296978026822", [
    { id: "55598268973382", price: "55.00" },
    { id: "55598268940614", price: "55.00" },
  ]),
  product("14958568177990", [
    { id: "54623384437062", price: "69.00" },
    { id: "54623384404294", price: "69.00" },
  ]),
];

/** Only the fields valueBasket reads; the rest of the row is irrelevant. */
const line = (o: Partial<OrderItem>) =>
  ({
    action: "CAMBIO",
    confirmed: false,
    quantity: 1,
    ...o,
  }) as OrderItem;

describe("valueBasket — order #311749", () => {
  it("owes nothing for two same-product size swaps at different sale depths", () => {
    const items = [
      line({
        productId: "15296978026822",
        variant_id: "55598268973382",
        new_variant_id: vgid("55598268940614"),
        price: "42.75",
      }),
      line({
        productId: "14958568177990",
        variant_id: "54623384437062",
        new_variant_id: vgid("54623384404294"),
        price: "47.03",
      }),
    ];

    const basket = valueBasket(items, CATALOGUE);

    expect(basket.returnPrice).toBeCloseTo(89.78, 2);
    expect(basket.exchangePrice).toBeCloseTo(89.78, 2);
    // The bug charged EUR 6.60 here.
    expect(basket.netAmount).toBeCloseTo(0, 2);
    expect(basket.degraded).toBe(false);
  });

  it("still weighs the ORIGINAL garments, not the replacements", () => {
    const items = [
      line({
        productId: "15296978026822",
        variant_id: "55598268973382",
        new_variant_id: vgid("55598268940614"),
        price: "42.75",
      }),
    ];
    expect(valueBasket(items, CATALOGUE).grams).toBe(400);
  });

  it("matches a bare order-line id against a GID catalogue id", () => {
    const items = [
      line({
        productId: "15296978026822",
        variant_id: "55598268973382", // BARE
        new_variant_id: vgid("55598268940614"), // GID
        price: "42.75",
      }),
    ];
    const b = valueBasket(items, CATALOGUE); // catalogue ids are GIDs
    expect(b.grams).toBe(400); // not FALLBACK_ITEM_GRAMS
    expect(b.netAmount).toBeCloseTo(0, 2);
  });
});

describe("parcelGrams resolves BARE productsorder variant ids", () => {
  it("uses the catalogue weight, not the fallback", () => {
    const items = [
      line({
        productId: "15296978026822",
        variant_id: "55598268973382", // BARE, as productsorder stores it
        new_variant_id: null,
        action: "DEVOLUCIÓN",
        price: "42.75",
      }),
    ];
    // 400g comes from the catalogue fixture. Before the fix this returned
    // FALLBACK_ITEM_GRAMS, because a bare id never matched a GID key.
    expect(valueBasket(items, CATALOGUE).grams).toBe(400);
    expect(valueBasket(items, CATALOGUE).grams).not.toBe(FALLBACK_ITEM_GRAMS);
  });

  it("multiplies by quantity", () => {
    const items = [
      line({
        productId: "15296978026822",
        variant_id: "55598268973382",
        new_variant_id: null,
        action: "DEVOLUCIÓN",
        quantity: 3,
        price: "42.75",
      }),
    ];
    expect(valueBasket(items, CATALOGUE).grams).toBe(1200);
  });

  it("still falls back for a variant that is genuinely gone", () => {
    const items = [
      line({
        productId: "99999999",
        variant_id: "88888888",
        new_variant_id: null,
        action: "DEVOLUCIÓN",
        price: "10.00",
      }),
    ];
    expect(valueBasket(items, CATALOGUE).grams).toBe(FALLBACK_ITEM_GRAMS);
  });
});
