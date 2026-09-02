// @vitest-environment jsdom

// Round 1 fix (R15): tests/returnMethodThreading.render.test.tsx renders
// SummaryComponent, but its fixture item is a DEVOLUCIÓN with no
// new_variant_id, so the CAMBIO branch added in this task — summary.tsx's
// `priceFor` and summaryLine.tsx's `newPrice` — was never actually
// exercised by a render. This proves it directly, reusing the exact
// #311749 fixture from tests/basket.test.ts: two same-product size swaps at
// DIFFERENT sale depths (42.75/55.00 and 47.03/69.00). A third,
// cross-product line is added beyond that fixture (see the comment on
// ITEMS[2] below) so a call-site regression that silently drops the
// `newPrice` prop — falling back to `item.price` — is actually
// observable: for a same-product swap `item.price` and the correct
// `priceFor(item)` are numerically identical by construction (both are
// the "paid" basis), so that specific mutation is undetectable on the
// #311749 pair alone.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SummaryComponent } from "@/app/[id]/components/summary/summary";
import { FeesProvider } from "@/app/[id]/feesContext";
import { en } from "@/lib/i18n/en";
import type { Product } from "@/types";

vi.mock("@/lib/i18n/context", () => ({
  useT: () => en,
  useLocale: () => "en",
}));

afterEach(() => {
  cleanup();
});

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

// The exact tests/basket.test.ts "order #311749" catalogue and fixture: both
// lines are same-product SIZE swaps (variant_id and new_variant_id belong to
// the same product), each paid at a different depth off the SAME list price
// (55.00 / 69.00) for both sizes of a product.
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

// Titles deliberately differ from the catalogue products' titles
// ("P15296978026822" / "P14958568177990") so the title assertion below can
// tell "newProduct wired through" apart from "fell back to item.title".
const ITEMS = [
  {
    id: 1,
    lineItemId: "gid://shopify/LineItem/1",
    orderId: "13217168851270",
    productId: "15296978026822",
    title: "Snapshot title A",
    variant_title: "S",
    variant_id: "55598268973382",
    price: "42.75",
    quantity: 1,
    changed: true,
    action: "CAMBIO",
    reason: null,
    notes: null,
    new_variant_title: "M",
    new_variant_id: vgid("55598268940614"),
    confirmed: false,
    return_id: null,
    refunded: null,
    credit: null,
    gift_card_id: null,
    return_line_item_id: null,
    transaction_id: null,
    transaction_amount: null,
  },
  {
    id: 2,
    lineItemId: "gid://shopify/LineItem/2",
    orderId: "13217168851270",
    productId: "14958568177990",
    title: "Snapshot title B",
    variant_title: "M",
    variant_id: "54623384437062",
    price: "47.03",
    quantity: 1,
    changed: true,
    action: "CAMBIO",
    reason: null,
    notes: null,
    new_variant_title: "L",
    new_variant_id: vgid("54623384404294"),
    confirmed: false,
    return_id: null,
    refunded: null,
    credit: null,
    gift_card_id: null,
    return_line_item_id: null,
    transaction_id: null,
    transaction_amount: null,
  },
  // Not part of the #311749 fixture: a CROSS-product exchange (variant_id
  // and new_variant_id belong to different products), so its correct price
  // (replacementPrice's "ratio" basis: round2(69.00 * (30.00 / 55.00)) =
  // 37.64) genuinely differs from item.price ("30.00") — unlike the two
  // same-product lines above. This is what makes a dropped-`newPrice`
  // regression at the SummaryLine call site observable at all.
  {
    id: 3,
    lineItemId: "gid://shopify/LineItem/3",
    orderId: "13217168851270",
    productId: "15296978026822",
    title: "Snapshot title C",
    variant_title: "S",
    variant_id: "55598268973382",
    price: "30.00",
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
  },
] as never;

describe("SummaryComponent's exchange rows agree with replacementPricing", () => {
  it("renders the replacement's title AND its correctly-priced amount, not the catalogue's raw list price", async () => {
    const { container } = render(
      <FeesProvider fees={[]}>
        <SummaryComponent
          items={ITEMS}
          shipping={false}
          final={true}
          allProducts={CATALOGUE}
        />
      </FeesProvider>
    );

    // The exchange rows live inside a Radix accordion panel that is
    // unmounted until opened — collapsed by default, no `defaultValue` is
    // passed. Open it, the same way a customer would.
    const user = userEvent.setup();
    await user.click(screen.getByText(en.summary.newProducts));

    const text = container.textContent ?? "";

    // R7: newProduct still drives the title. Both catalogue product titles
    // must be on screen — they can ONLY come from the exchange row's
    // `newProduct` prop, nothing else in this render uses them.
    expect(text).toContain("P15296978026822");
    expect(text).toContain("P14958568177990");

    // The actually-paid amounts are on screen (also true of the "items to
    // return" section, which always shows item.price — this is the weaker
    // half of the assertion).
    expect(text).toContain("€42.75");
    expect(text).toContain("€47.03");

    // The meaningful half: the exchange row must NOT show the catalogue's
    // raw list price for the target variant. This is exactly what the old,
    // deleted `newProduct.variants.edges[0]?.node.price` lookup rendered —
    // both sizes in this fixture list at 55.00 / 69.00, so a regression back
    // to that lookup reintroduces these two amounts.
    expect(text).not.toContain("€55.00");
    expect(text).not.toContain("€69.00");

    // The cross-product line: its correctly-ratio'd price (37.64) is on
    // screen, and its item.price fallback (30.00) is not — this is what
    // catches a dropped `newPrice` prop at the SummaryLine call site, which
    // the two same-product lines above cannot (see the header comment).
    expect(text).toContain("€37.64");
    expect(text).not.toContain("€30.00");
  });
});
