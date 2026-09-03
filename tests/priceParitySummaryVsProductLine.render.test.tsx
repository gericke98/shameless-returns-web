// @vitest-environment jsdom

// F2 (final whole-branch review): summary.tsx/valueBasket and
// productLineClient.tsx/dialogForm.tsx both call replacementPricing's
// replacementPrice/replacementPriceForVariant, but only summary.tsx (and
// valueBasket) passed the order's real fallback ratio —
// `orderRatio(items, index)`. productLineClient.tsx and dialogForm.tsx
// hardcoded `null`, so whenever a line's own original variant has left the
// catalogue (degraded to the "median" basis) the "chosen replacement" card
// and the edit dialog's preview/dropdown prices disagreed with the summary
// and the Stripe total for the exact same line — by the full gap between the
// order's median discount and the replacement's raw list price.
//
// This proves the two surfaces agree once ProductLineClient receives the
// SAME `orderRatio(items, index)` value summary.tsx computes, using a
// fixture engineered to hit the "median" basis: line A's own original
// variant is not in the catalogue at all (so its own ratio is null), and
// line B's is, giving the order a single resolvable ratio (0.70) for the
// median to equal. Line A's replacement lists at 100.00, so the two bases
// disagree by a full EUR 30 (100.00 raw vs 70.00 median-priced) — not a
// rounding-sized gap that could pass by coincidence.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SummaryComponent } from "@/app/[id]/components/summary/summary";
import { ProductLineClient } from "@/app/[id]/components/productLineClient";
import { FeesProvider } from "@/app/[id]/feesContext";
import type { FeeTable } from "@/lib/fees";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import { orderRatio, indexCatalogue, type PricedLine } from "@/lib/replacementPricing";
import { en } from "@/lib/i18n/en";
import type { Product } from "@/types";

vi.mock("@/lib/i18n/context", () => ({
  useT: () => en,
  useLocale: () => "en",
}));

// ProductLineClient statically imports FormProduct from ./dialogForm, which
// imports actions/updateOrder -> db/drizzle.ts. That throws at import time
// without a live DATABASE_URL, so it must be stubbed even though this test
// never opens the dialog. Same stub as productLineClientPricing.render.test.tsx.
vi.mock("@/actions/updateOrder", () => ({
  updateOrder: vi.fn(),
  anularOrder: vi.fn(),
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

// Line A's ORIGINAL product ("999999999999999") is deliberately absent from
// this catalogue — genuinely gone (or DRAFT; see lib/basket.ts's corrected
// docstring). Its replacement product IS present and lists at 100.00.
const REPLACEMENT = product("15296978026822", [
  { id: "55598268940614", price: "100.00" },
]);
// Line B's original variant, present, prices its ratio at 35.00 / 50.00 = 0.70.
const B_PRODUCT = product("14958568177990", [
  { id: "54623384437062", price: "50.00" },
]);
const CATALOGUE = [REPLACEMENT, B_PRODUCT];

const lineA = {
  id: 1,
  lineItemId: "gid://shopify/LineItem/1",
  orderId: "13217168851270",
  productId: "999999999999999",
  title: "Line A — original left the catalogue",
  variant_title: "S",
  variant_id: "888888888888888",
  price: "40.00",
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
} as never;

const lineB = {
  id: 2,
  lineItemId: "gid://shopify/LineItem/2",
  orderId: "13217168851270",
  productId: "14958568177990",
  title: "Line B — establishes the order's median ratio",
  variant_title: "M",
  variant_id: "54623384437062",
  price: "35.00",
  quantity: 1,
  changed: false,
  action: "DEVOLUCIÓN",
  reason: null,
  notes: null,
  new_variant_title: null,
  new_variant_id: null,
  confirmed: false,
  return_id: null,
  refunded: null,
  credit: null,
  gift_card_id: null,
  return_line_item_id: null,
  transaction_id: null,
  transaction_amount: null,
} as never;

const ITEMS = [lineA, lineB];

// Empty table: feesForCountry falls back to the '*' row, which is absent, so
// every leg resolves to []. Reproduces the old `fees={[]}` fixture exactly.
const EMPTY_TABLE: FeeTable = {};
const ORDER = {
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "ES",
  deliveryName: null,
  deliveryAddress1: null,
  deliveryAddress2: null,
  deliveryZip: null,
  deliveryCity: null,
  deliveryProvince: null,
  deliveryCountry: null,
} satisfies OrderAddressFields;

describe("summary and ProductLineClient agree on the median basis", () => {
  it("prices line A's replacement the same way in both surfaces: 70.00, not the raw 100.00 list price", async () => {
    // Surface 1: the summary/Stripe path. summary.tsx derives its own
    // fallbackRatio via orderRatio(items, index) internally, same as
    // valueBasket (and so createStripeUrl) does.
    const { container: summaryContainer } = render(
      <FeesProvider table={EMPTY_TABLE} order={ORDER}>
        <SummaryComponent
          items={ITEMS}
          shipping={false}
          final={true}
          allProducts={CATALOGUE}
        />
      </FeesProvider>
    );
    const user = userEvent.setup();
    await user.click(screen.getByText(en.summary.newProducts));
    const summaryText = summaryContainer.textContent ?? "";
    expect(summaryText).toContain("€70.00");
    expect(summaryText).not.toContain("€100.00");
    cleanup();

    // Surface 2: the "chosen replacement" card, given the SAME order-wide
    // ratio a real screen (firstWindow.tsx / lastWindow.tsx) would compute
    // once and thread down — exactly what summary.tsx computed above.
    const index = indexCatalogue(CATALOGUE);
    const fallbackRatio = orderRatio(ITEMS as unknown as PricedLine[], index);
    expect(fallbackRatio).toBeCloseTo(0.7, 5);

    const { container: cardContainer } = render(
      <ProductLineClient
        orderProduct={lineA}
        product={REPLACEMENT}
        allProducts={CATALOGUE}
        fallbackRatio={fallbackRatio}
      />
    );
    const cardText = cardContainer.textContent ?? "";

    // The point of this test: both surfaces must show the SAME number for
    // the SAME line. Before this line received the order's real fallback
    // ratio it hardcoded `null`, landing on the "none" basis (raw list
    // price, 100.00) instead of "median" (70.00) — a EUR 30 gap between two
    // screens in the same flow.
    expect(cardText).toContain("€70.00");
    expect(cardText).not.toContain("€100.00");
  });
});
