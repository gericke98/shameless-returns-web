import { describe, expect, it } from "vitest";
import {
  indexCatalogue,
  lineRatio,
  orderRatio,
  replacementPrice,
  replacementPriceForVariant,
  type PricedLine,
} from "@/lib/replacementPricing";
import type { Product } from "@/types";

const vgid = (n: string) => `gid://shopify/ProductVariant/${n}`;

/** Minimal catalogue shaped exactly like getProducts() returns. */
function product(
  productId: string,
  variants: { id: string; price: string }[]
): Product {
  return {
    id: `gid://shopify/Product/${productId}`,
    title: `P${productId}`,
    handle: `p${productId}`,
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

// Order #311749, 2026-08-27. Sale prices paid; catalogue is back to list.
const CREWNECK = product("15296978026822", [
  { id: "55598268973382", price: "55.00" }, // Large, the one he bought
  { id: "55598268940614", price: "55.00" }, // Medium, the one he wants
]);
const PANTS = product("14958568177990", [
  { id: "54623384437062", price: "69.00" }, // Large (42), bought
  { id: "54623384404294", price: "69.00" }, // Medium (40), wanted
]);
const CATALOGUE = [CREWNECK, PANTS];

const franCrewneck: PricedLine = {
  productId: "15296978026822",
  variant_id: "55598268973382", // BARE, as productsorder stores it
  new_variant_id: vgid("55598268940614"),
  price: "42.75",
};
const franPants: PricedLine = {
  productId: "14958568177990",
  variant_id: "54623384437062",
  new_variant_id: vgid("54623384404294"),
  price: "47.03",
};

describe("replacementPrice — order #311749 regression", () => {
  it("charges nothing for either size swap", () => {
    const index = indexCatalogue(CATALOGUE);
    const fallback = orderRatio([franCrewneck, franPants], index);

    const crewneck = replacementPrice(franCrewneck, index, fallback);
    const pants = replacementPrice(franPants, index, fallback);

    expect(crewneck).toEqual({ price: 42.75, basis: "paid" });
    expect(pants).toEqual({ price: 47.03, basis: "paid" });

    const paid = 42.75 + 47.03;
    const owed = crewneck.price + pants.price;
    expect(Math.round((paid - owed) * 100) / 100).toBe(0);
  });

  it("does not borrow line 1's ratio for line 2", () => {
    const index = indexCatalogue(CATALOGUE);
    // The old bug: 69.00 * (42.75/55.00) = 53.63, a EUR 6.60 overcharge.
    const pants = replacementPrice(franPants, index, orderRatio([], index));
    expect(pants.price).not.toBeCloseTo(53.63, 2);
    expect(pants.price).toBe(47.03);
  });
});

describe("same-product swaps never depend on the catalogue", () => {
  it("returns the paid price for any catalogue, including an empty one", () => {
    for (const cat of [CATALOGUE, [], [PANTS]]) {
      const index = indexCatalogue(cat);
      expect(replacementPrice(franCrewneck, index, null)).toEqual({
        price: 42.75,
        basis: "paid",
      });
    }
  });

  it("is unmoved when the catalogue price triples", () => {
    const inflated = [
      product("15296978026822", [
        { id: "55598268973382", price: "165.00" },
        { id: "55598268940614", price: "165.00" },
      ]),
    ];
    const index = indexCatalogue(inflated);
    expect(replacementPrice(franCrewneck, index, null).price).toBe(42.75);
  });
});

describe("cross-product exchanges carry the line's own discount depth", () => {
  const crossToPants: PricedLine = {
    ...franCrewneck,
    new_variant_id: vgid("54623384404294"), // pants, a DIFFERENT product
  };

  it("applies the line's own ratio, not a sibling's", () => {
    const index = indexCatalogue(CATALOGUE);
    // ratio = 42.75 / 55.00 = 0.777272...; 69.00 * that = 53.63
    expect(replacementPrice(crossToPants, index, null)).toEqual({
      price: 53.63,
      basis: "ratio",
    });
  });

  it("clamps the ratio at 1 so a replacement never exceeds its list price", () => {
    // Original has since been marked down BELOW what was paid: 42.75 / 30 = 1.425
    const markedDown = [
      product("15296978026822", [
        { id: "55598268973382", price: "30.00" },
        { id: "55598268940614", price: "30.00" },
      ]),
      PANTS,
    ];
    const index = indexCatalogue(markedDown);
    expect(replacementPrice(crossToPants, index, null)).toEqual({
      price: 69.0,
      basis: "ratio",
    });
  });
});

describe("the bare-id trap", () => {
  it("resolves a BARE original variant_id against GID catalogue keys", () => {
    const index = indexCatalogue(CATALOGUE);
    // If variantGid() were missing, this returns null and every cross-product
    // line silently degrades to the median/none fallback.
    expect(lineRatio(franCrewneck, index)).toBeCloseTo(42.75 / 55.0, 6);
  });
});

describe("fallbacks when the original variant has left the catalogue", () => {
  const orphan: PricedLine = {
    productId: "99999999",
    variant_id: "88888888", // not in the catalogue
    new_variant_id: vgid("54623384404294"),
    price: "40.00",
  };

  it("reports basis 'median' and uses the order's median ratio", () => {
    const index = indexCatalogue(CATALOGUE);
    const fallback = orderRatio([franCrewneck, franPants, orphan], index);
    // ratios: 42.75/55 = 0.777272, 47.03/69 = 0.681594 -> median = 0.729433
    expect(fallback).toBeCloseTo((42.75 / 55.0 + 47.03 / 69.0) / 2, 6);
    expect(replacementPrice(orphan, index, fallback)).toEqual({
      price: 50.33,
      basis: "median",
    });
  });

  it("reports basis 'none' and charges list price when nothing resolves", () => {
    const index = indexCatalogue(CATALOGUE);
    expect(replacementPrice(orphan, index, null)).toEqual({
      price: 69.0,
      basis: "none",
    });
  });

  it("returns the paid price when the REPLACEMENT cannot be priced", () => {
    const index = indexCatalogue([]);
    expect(replacementPrice(franPants, index, null)).toEqual({
      price: 47.03,
      basis: "paid",
    });
  });
});

describe("lines with no replacement chosen", () => {
  it("prices at what was paid", () => {
    const index = indexCatalogue(CATALOGUE);
    const plain: PricedLine = { ...franPants, new_variant_id: null };
    expect(replacementPrice(plain, index, null)).toEqual({
      price: 47.03,
      basis: "paid",
    });
  });
});

describe("replacementPriceForVariant — the picker", () => {
  it("prices a candidate variant the customer has not chosen yet", () => {
    const index = indexCatalogue(CATALOGUE);
    // Same product: what he paid, not the EUR 55 list price on screen today.
    expect(
      replacementPriceForVariant(
        franCrewneck,
        vgid("55598268940614"),
        index,
        null
      ).price
    ).toBe(42.75);
    // Different product: his own depth carried across.
    expect(
      replacementPriceForVariant(
        franCrewneck,
        vgid("54623384404294"),
        index,
        null
      ).price
    ).toBe(53.63);
  });
});

describe("orderRatio", () => {
  it("is null when no line resolves", () => {
    expect(orderRatio([], indexCatalogue(CATALOGUE))).toBeNull();
  });

  it("takes the middle value for an odd number of lines", () => {
    const index = indexCatalogue(CATALOGUE);
    const half: PricedLine = { ...franPants, price: "34.50" }; // 0.5
    const ratio = orderRatio([franCrewneck, franPants, half], index);
    expect(ratio).toBeCloseTo(47.03 / 69.0, 6);
  });
});
