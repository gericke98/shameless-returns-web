import { describe, expect, it } from "vitest";
import { buildReturnInput } from "@/lib/returnPayload";

// `new_variant_id` is stored as a full GID; a builder that wraps it in the
// prefix a second time ('gid://shopify/ProductVariant/gid://shopify/...')
// makes Shopify reject the whole mutation (order #310741, 2026-08-13). The
// stock-hold draft builder that first hit it is gone (FX); the return input
// builder must never repeat it.

describe("buildReturnInput exchange line ids", () => {
  // Same double-prefix, currently masked because NATIVE_EXCHANGES is off.
  // Turning that flag on would have failed returnCreate the same way.
  const line = {
    variant_id: "55904239812934",
    fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/19590829408582",
    quantity: 1,
    action: "CAMBIO",
    reason: "TOO_SMALL",
    notes: "",
    new_variant_id: "gid://shopify/ProductVariant/55904239845702",
  };

  it("does not double-prefix a stored GID", () => {
    const input = buildReturnInput("13158935429446", [line], 5, {
      includeExchangeItems: true,
    });
    expect(input.exchangeLineItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/55904239845702", quantity: 1 },
    ]);
  });

  it("drops an unresolvable exchange line rather than the whole mutation", () => {
    const input = buildReturnInput(
      "13158935429446",
      [{ ...line, new_variant_id: "not-an-id" }],
      5,
      { includeExchangeItems: true }
    );
    // No usable exchange line -> omit the key entirely, exactly as the existing
    // empty-list handling does: Shopify reads [] as "an exchange with nothing
    // in it".
    expect(input.exchangeLineItems).toBeUndefined();
  });
});
