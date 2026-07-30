import { describe, expect, it } from "vitest";
import { REASON_KEYS } from "@/placeholder";
import { toShopifyReturnReason } from "@/lib/shopifyReturnReason";

// `returnCreate` sent a hardcoded `returnReason: COLOR` for EVERY return, so
// Shopify's merchandising data said "Color" no matter what the customer chose.
// Order #310972 is filed as COLOR when the customer picked "Too small".
//
// The enum values below are Shopify's own (introspected from ReturnReason on
// the 2025-01 Admin API), not invented.

const SHOPIFY_ENUM = new Set([
  "SIZE_TOO_SMALL",
  "SIZE_TOO_LARGE",
  "UNWANTED",
  "NOT_AS_DESCRIBED",
  "WRONG_ITEM",
  "DEFECTIVE",
  "STYLE",
  "COLOR",
  "OTHER",
  "UNKNOWN",
]);

describe("toShopifyReturnReason", () => {
  it("maps the size reasons to the matching Shopify sizes", () => {
    expect(toShopifyReturnReason("TOO_SMALL")).toBe("SIZE_TOO_SMALL");
    expect(toShopifyReturnReason("TOO_BIG")).toBe("SIZE_TOO_LARGE");
  });

  it("maps damage and wrong-item to their Shopify equivalents", () => {
    expect(toShopifyReturnReason("DAMAGED")).toBe("DEFECTIVE");
    expect(toShopifyReturnReason("WRONG_ITEM")).toBe("WRONG_ITEM");
    expect(toShopifyReturnReason("NOT_AS_SHOWN")).toBe("NOT_AS_DESCRIBED");
  });

  it("maps taste and change-of-mind reasons", () => {
    expect(toShopifyReturnReason("DISLIKE")).toBe("STYLE");
    expect(toShopifyReturnReason("BOUGHT_OPTIONS")).toBe("UNWANTED");
    expect(toShopifyReturnReason("UNCOMFORTABLE")).toBe("UNWANTED");
  });

  it("falls back to OTHER for reasons Shopify has no slot for", () => {
    expect(toShopifyReturnReason("LATE")).toBe("OTHER");
    expect(toShopifyReturnReason("OTHER")).toBe("OTHER");
  });

  it("never guesses COLOR — the old hardcoded value", () => {
    for (const key of REASON_KEYS) {
      expect(toShopifyReturnReason(key)).not.toBe("COLOR");
    }
  });

  it("degrades to OTHER for missing or unrecognised input", () => {
    expect(toShopifyReturnReason(null)).toBe("OTHER");
    expect(toShopifyReturnReason(undefined)).toBe("OTHER");
    expect(toShopifyReturnReason("")).toBe("OTHER");
    expect(toShopifyReturnReason("Me queda pequeño")).toBe("OTHER");
  });

  it("emits only values the Shopify enum actually accepts", () => {
    // A value outside the enum fails the whole returnCreate mutation.
    for (const key of REASON_KEYS) {
      expect(SHOPIFY_ENUM).toContain(toShopifyReturnReason(key));
    }
  });

  it("covers every reason the portal can store", () => {
    // A new REASON_KEY with no mapping must not silently become COLOR again.
    for (const key of REASON_KEYS) {
      expect(typeof toShopifyReturnReason(key)).toBe("string");
    }
  });
});
