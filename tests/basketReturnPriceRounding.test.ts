import { describe, expect, it } from "vitest";
import { valueBasket } from "@/lib/basket";
import { resolveFee, sameZone, UNBOUNDED_MAX_GRAMS, type CountryBands } from "@/lib/fees";
import { calculatePriceWithDiscount } from "@/utils/order-utils";
import type { OrderItem, OrderLineItem, Product } from "@/types";

// F1 (final whole-branch review): `returnPrice` (lib/basket.ts) summed
// item.price UNROUNDED, while `exchangePrice` summed replacementPrice's
// already-round2'd output. Task 5 (utils/order-utils.ts's
// calculatePriceWithDiscount) made an unrounded per-unit price reachable:
// `unit - allocated/quantity` for a qty>=3 line whose allocation does not
// divide evenly, and db/repository.ts stores that value verbatim via
// `.toString()`. A same-product size swap on such a line then compared an
// unrounded returnPrice against a rounded exchangePrice, landing netAmount a
// fraction of a cent off zero — enough to flip resolveFee's Rule A
// (`netAmount > 0` => return lane) from the correct exchange lane to the
// return lane, undercharging the outbound leg entirely (EUR 6.00 charged
// instead of EUR 9.50, no outbound leg billed at all).

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

describe("valueBasket returnPrice rounding — the fee-lane flip (F1)", () => {
  it("keeps a same-product swap on the EXCHANGE lane, not the RETURN lane, when a qty>=3 line's discount doesn't divide evenly", () => {
    // Reproduce the exact storage path: Shopify's raw line, discount
    // allocated against the LINE not the unit, run through the real
    // calculatePriceWithDiscount — the same function db/repository.ts feeds
    // straight into `.toString()` when the row is saved.
    const storedPrice = calculatePriceWithDiscount({
      id: "1",
      title: "T",
      price: "55.00",
      variant_id: "V1",
      variant_title: "M",
      quantity: 3,
      action: "CAMBIO",
      discount_allocations: [{ amount: "12.35" }],
      product_id: 1,
    } as OrderLineItem);

    // Genuinely unrounded — this is the value that gets stored verbatim.
    expect(storedPrice).toBeCloseTo(50.883333333333, 10);
    expect(Number.isInteger(storedPrice * 100)).toBe(false);

    const catalogue = [
      product("P1", [
        { id: "V1", price: "55.00" },
        { id: "V2", price: "55.00" },
      ]),
    ];

    // A same-product SIZE swap (V1 -> V2, same product P1), stored exactly as
    // productsorder would hold it: `price` is the unrounded per-unit
    // discounted price, `.toString()`'d.
    const item = {
      action: "CAMBIO",
      confirmed: false,
      quantity: 3,
      productId: "P1",
      variant_id: "V1",
      new_variant_id: vgid("V2"),
      price: storedPrice.toString(),
    } as unknown as OrderItem;

    const basket = valueBasket([item], catalogue);

    // A same-product swap must cost exactly what was paid: net owed is zero.
    expect(basket.netAmount).toBeCloseTo(0, 10);
    expect(basket.netAmount).toBe(0);

    const bands: CountryBands = [
      { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 600, exchangeFeeCents: 950 },
    ];
    const fee = resolveFee(sameZone(bands), basket);

    // The bug: netAmount landed a fraction of a cent ABOVE zero, so Rule A
    // ("netAmount > 0" => return) picked the return lane (feeCents 600,
    // outboundLegCents 0) instead of the exchange lane below.
    expect(fee.kind).toBe("exchange");
    expect(fee.feeCents).toBe(950);
    expect(fee.outboundLegCents).toBe(350);
    expect(fee.returnLegCents).toBe(600);
  });
});
