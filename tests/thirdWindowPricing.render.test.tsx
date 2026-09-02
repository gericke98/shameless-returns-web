// @vitest-environment jsdom

// thirdWindow.tsx used to re-implement lib/basket's valueBasket inline,
// pricing an exchange's replacement off the raw catalogue variant price
// instead of the discount depth the line actually paid. That disagreed with
// the amount Stripe charges the moment an order carried lines at different
// sale depths — exactly the shape of order #311749 (see tests/basket.test.ts).
// This proves the screen's rendered total now equals valueBasket's netAmount,
// not the value the old inline copy would have produced.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThirdWindow } from "@/app/[id]/windows/thirdWindow";
import { FeesProvider } from "@/app/[id]/feesContext";
import { valueBasket } from "@/lib/basket";
import { en } from "@/lib/i18n/en";
import type { OrderItem, Product } from "@/types";

const vgid = (n: string) => `gid://shopify/ProductVariant/${n}`;

vi.mock("@/lib/i18n/context", () => ({
  useT: () => en,
  useLocale: () => "en",
}));

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

// Same fixture as tests/basket.test.ts's order #311749 case: both lines are
// same-product size swaps, but at DIFFERENT sale depths (42.75/55.00 vs.
// 47.03/69.00). The old inline copy in thirdWindow never checked "same
// product" at all — it always read the target variant's raw list price — so
// it would have priced this exchange at 55.00 + 69.00 = 124.00 instead of
// what was actually paid, 89.78.
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

const baseItem = (overrides: Partial<OrderItem>): OrderItem =>
  ({
    id: 1,
    lineItemId: "gid://shopify/LineItem/1",
    orderId: "13217168851270",
    title: "Test product",
    variant_title: "S",
    quantity: 1,
    changed: false,
    action: "CAMBIO",
    reason: null,
    notes: null,
    new_variant_title: "M",
    confirmed: false,
    return_id: null,
    refunded: null,
    credit: null,
    gift_card_id: null,
    return_line_item_id: null,
    transaction_id: null,
    transaction_amount: null,
    ...overrides,
  }) as OrderItem;

const ITEMS: OrderItem[] = [
  baseItem({
    id: 1,
    productId: "15296978026822",
    variant_id: "55598268973382",
    new_variant_id: vgid("55598268940614"),
    price: "42.75",
  }),
  baseItem({
    id: 2,
    productId: "14958568177990",
    variant_id: "54623384437062",
    new_variant_id: vgid("54623384404294"),
    price: "47.03",
  }),
];

describe("ThirdWindow total agrees with valueBasket", () => {
  it("renders the shared valuation's netAmount, not the old inline copy's total", () => {
    const expected = valueBasket(ITEMS, CATALOGUE).netAmount;
    // Sanity check on the fixture itself: this order nets close to zero
    // because both lines were paid at their own sale depth. The bug this
    // task closes would have rendered -34.22 instead (124.00 - 89.78 also
    // subtracts inverted, but the point is: NOT this value).
    expect(expected).toBeCloseTo(0, 2);

    render(
      <FeesProvider fees={[]}>
        <ThirdWindow
          items={ITEMS}
          shipping={false}
          position={2}
          setPosition={() => {}}
          setCredito={() => {}}
          credito={false}
          allProducts={CATALOGUE}
          id="13217168851270"
        />
      </FeesProvider>
    );

    const expectedText = `${en.third.totalRefund}: €${expected.toFixed(2)}`;
    expect(screen.getAllByText(expectedText).length).toBeGreaterThan(0);

    // The value the old, deleted inline copy would have rendered for this
    // fixture — it must be gone.
    expect(screen.queryByText(/-€34\.22|€124\.00/)).toBeNull();
  });
});
