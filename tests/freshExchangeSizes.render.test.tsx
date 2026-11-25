// @vitest-environment jsdom

// A fresh same-product exchange (Codex review of F1, finding 1). The dialog
// starts on the garment being returned, read by `getProduct`, and offers a
// size only when `isOfferedReplacement` sees an ACTIVE product with stock. So
// the product reader must select `status`: the fake Shopify below answers
// ONLY the fields the real query selects, as GraphQL does, so a reader that
// forgets one hands the dialog the same broken shape it would in production.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { en } from "@/lib/i18n/en";
import { fakeShopifyFetch } from "./support/shopifyFake";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", async () => (await import("./support/drizzleMock")).drizzleModule(await (() => ({ default: {}, transact: async () => [], readQuery: async () => ({ rows: [] }) }))()));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/i18n/context", () => ({ useT: () => en, useLocale: () => "en" }));
vi.mock("@/actions/lines", () => ({ setLineSelection: vi.fn(), clearLineSelection: vi.fn() }));

/** Shopify's product, with every field it has; the query decides what comes back. */
const SHOPIFY = {
  product: {
    id: "gid://shopify/Product/15296978026822",
    title: "Wide jeans",
    status: "ACTIVE",
    handle: "wide-jeans",
    description: "",
    vendor: "Shameless",
    images: { edges: [{ node: { url: "https://cdn.example/p.jpg" } }] },
    variants: {
      edges: [
        { node: { id: "gid://shopify/ProductVariant/1", price: "55.00", title: "S", inventoryQuantity: 4, inventoryItem: { measurement: { weight: { value: 400, unit: "GRAMS" } } } } },
        { node: { id: "gid://shopify/ProductVariant/2", price: "55.00", title: "M", inventoryQuantity: 0, inventoryItem: { measurement: { weight: { value: 400, unit: "GRAMS" } } } } },
        { node: { id: "gid://shopify/ProductVariant/3", price: "55.00", title: "L", inventoryQuantity: 2, inventoryItem: { measurement: { weight: { value: 400, unit: "GRAMS" } } } } },
      ],
    },
  },
};

const orderProduct = {
  id: 1,
  lineItemId: "gid://shopify/LineItem/1",
  orderId: "13217168851270",
  productId: "15296978026822",
  title: "Wide jeans",
  variant_title: "M",
  variant_id: "2",
  price: "55.00",
  quantity: 1,
  changed: false,
  action: "CAMBIO",
  reason: "TOO_SMALL",
  notes: null,
  new_variant_title: null,
  new_variant_id: null,
  confirmed: false,
  return_id: null,
  refunded: null,
  credit: null,
  return_line_item_id: null,
  transaction_id: null,
  transaction_amount: null,
} as never;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.invalid";
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "placeholder";
  vi.stubGlobal("fetch", fakeShopifyFetch(SHOPIFY));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a fresh same-product exchange", () => {
  it("offers the in-stock sizes of the product getProduct read, and only those", async () => {
    const { getProduct } = await import("@/db/queries");
    const { FormProduct } = await import("@/app/[id]/components/dialogForm");
    const product = await getProduct("15296978026822");

    render(
      <FormProduct
        product={product}
        orderProduct={orderProduct}
        changed={false}
        setChanged={() => {}}
        onSuccess={() => {}}
        allProducts={[]}
        fallbackRatio={null}
      />
    );

    const option = (size: string) => screen.getByRole("option", { name: size }) as HTMLOptionElement;
    expect([option("S").disabled, option("M").disabled, option("L").disabled]).toEqual([false, true, false]);
  });
});
