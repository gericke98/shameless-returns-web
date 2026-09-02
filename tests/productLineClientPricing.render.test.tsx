// @vitest-environment jsdom

// Round 1 fix (R15): tests/returnMethodThreading.render.test.tsx exercises
// LastWindow end-to-end but its fixture item has no `newp`, so
// ProductLineClient's "chosen replacement" card — the one whose price
// changed in this task (productLineClient.tsx's ProductInfo, R8) — was never
// actually rendered by any test. This proves it directly: a cross-product
// exchange line renders the PAID-ratio price via formatEuros, not the
// replacement's raw catalogue list price.

import { describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { ProductLineClient } from "@/app/[id]/components/productLineClient";
import { en } from "@/lib/i18n/en";
import type { Product } from "@/types";

vi.mock("@/lib/i18n/context", () => ({
  useT: () => en,
  useLocale: () => "en",
}));

// ProductLineClient statically imports FormProduct from ./dialogForm, which
// imports actions/updateOrder -> db/drizzle.ts. That throws at import time
// without a live DATABASE_URL, so it must be stubbed even though this test
// never opens the dialog. Same stub as returnMethodThreading.render.test.tsx.
vi.mock("@/actions/updateOrder", () => ({
  updateOrder: vi.fn(),
  anularOrder: vi.fn(),
}));

const vgid = (n: string) => `gid://shopify/ProductVariant/${n}`;

function product(id: string, variants: { id: string; price: string }[]): Product {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    handle: `p${id}`,
    description: "",
    images: { edges: [] },
    image: { src: "/placeholder.jpg" },
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

// Original garment: bought at 42.75 against a 55.00 list (ratio 0.7773).
// Replacement is a DIFFERENT product listing 69.00 — a cross-product
// exchange, so the same-product short-circuit in replacementPriceForVariant
// cannot fire and the customer's own discount ratio must be applied:
// round2(69.00 * (42.75 / 55.00)) = 53.63. The bug this task fixes rendered
// the raw 69.00 here instead.
const ORIGINAL = product("15296978026822", [
  { id: "55598268973382", price: "55.00" },
]);
const REPLACEMENT = product("14958568177990", [
  { id: "54623384437062", price: "69.00" },
]);
const ALL_PRODUCTS = [ORIGINAL, REPLACEMENT];

const orderProduct = {
  id: 1,
  lineItemId: "gid://shopify/LineItem/1",
  orderId: "13217168851270",
  productId: "15296978026822",
  title: "P15296978026822",
  variant_title: "S",
  variant_id: "55598268973382",
  price: "42.75",
  quantity: 1,
  changed: true,
  action: "CAMBIO",
  reason: null,
  notes: null,
  new_variant_title: "M",
  new_variant_id: vgid("54623384437062"),
  confirmed: false,
  return_id: null,
  refunded: null,
  credit: null,
  gift_card_id: null,
  return_line_item_id: null,
  transaction_id: null,
  transaction_amount: null,
} as never;

afterEach(() => {
  cleanup();
});

describe("ProductLineClient — the chosen-replacement card", () => {
  it("shows the customer's own discount ratio applied to the replacement, not its catalogue list price", () => {
    const { container } = render(
      <ProductLineClient
        orderProduct={orderProduct}
        product={ORIGINAL}
        allProducts={ALL_PRODUCTS}
        fallbackRatio={null}
      />
    );

    // The replacement's price/title span renders three sibling text nodes
    // ("M", " - ", "€53.63"), so a plain getByText("€53.63") never matches —
    // RTL matches an element's whole normalised textContent, and this
    // element's is "M - €53.63". Assert on the rendered text directly.
    //
    // "42.75" -> 53.63 against a 69.00 list, formatEuros-formatted, matching
    // the format the price directly above it already uses in the same card.
    expect(container.textContent).toContain("€53.63");

    // Neither the raw list price nor its old un-formatted rendering
    // ("69.00 €") is on screen.
    expect(container.textContent).not.toContain("€69.00");
    expect(container.textContent).not.toMatch(/69\.00\s*€/);
  });
});
