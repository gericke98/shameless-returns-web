import { describe, expect, it } from "vitest";
import { variantGid } from "@/lib/shopifyIds";

// `productsorder` stores the two variant columns in DIFFERENT shapes:
//
//   variant_id      55904239812934                                  (bare)
//   new_variant_id  gid://shopify/ProductVariant/55904239845702      (GID)
//
// Nothing enforces that, and every builder that wrapped `new_variant_id` in a
// GID prefix produced a double-prefixed id that Shopify rejects outright:
//
//   Invalid global id 'gid://shopify/ProductVariant/gid://shopify/ProductVariant/55904239845702'
//
// That is why not one of the 259 exchange lines in the table has ever had a
// stock hold placed against it. This helper is the single place that decides
// what a variant id looks like, and it is idempotent so it cannot matter which
// shape a column happens to hold.

describe("variantGid", () => {
  it("wraps a bare numeric id", () => {
    expect(variantGid("55904239812934")).toBe(
      "gid://shopify/ProductVariant/55904239812934"
    );
  });

  it("leaves an id that is already a GID alone", () => {
    expect(variantGid("gid://shopify/ProductVariant/55904239845702")).toBe(
      "gid://shopify/ProductVariant/55904239845702"
    );
  });

  it("is idempotent", () => {
    const once = variantGid("55904239845702");
    expect(variantGid(once)).toBe(once);
    expect(variantGid(variantGid(once))).toBe(once);
  });

  it("repairs an already double-prefixed id", () => {
    // Exactly the string that went to Shopify for order #310741.
    expect(
      variantGid(
        "gid://shopify/ProductVariant/gid://shopify/ProductVariant/55904239845702"
      )
    ).toBe("gid://shopify/ProductVariant/55904239845702");
  });

  it("accepts a number", () => {
    expect(variantGid(55904239812934)).toBe(
      "gid://shopify/ProductVariant/55904239812934"
    );
  });

  it("returns null for anything it cannot resolve", () => {
    // Null rather than a malformed id: one bad line must never be able to fail
    // the mutation for every OTHER line in the same submission.
    for (const bad of [null, undefined, "", "   ", "not-an-id", "gid://shopify/Product/123", "gid://shopify/ProductVariant/"]) {
      expect(variantGid(bad as any)).toBeNull();
    }
  });

  it("trims surrounding whitespace", () => {
    expect(variantGid("  55904239812934 ")).toBe(
      "gid://shopify/ProductVariant/55904239812934"
    );
  });
});
