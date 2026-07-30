import { describe, expect, it } from "vitest";
import { exchangeFromProducts } from "@/lib/exchange";

// Derives the email's exchange block from the order's own line items, so a
// CAMBIO customer is told what is coming back to them instead of receiving the
// plain "your return was created" copy.

const amalfiExchange = {
  title: "STAR AMALFI PANTS",
  variant_title: "Small (38)",
  new_variant_title: "Medium (40)",
  action: "CAMBIO",
  quantity: 1,
};

const plainReturn = {
  title: "STAR AMALFI PANTS",
  variant_title: "Small (38)",
  new_variant_title: null,
  action: "DEVOLUCIÓN",
  quantity: 1,
};

describe("exchangeFromProducts", () => {
  it("returns null when nothing is being exchanged", () => {
    expect(exchangeFromProducts([plainReturn])).toBeNull();
  });

  it("returns null for an empty order", () => {
    expect(exchangeFromProducts([])).toBeNull();
  });

  it("names the replacement item and size", () => {
    expect(exchangeFromProducts([amalfiExchange])).toEqual({
      replacements: ["STAR AMALFI PANTS — Medium (40)"],
    });
  });

  it("lists every exchanged line, ignoring returned ones", () => {
    const tee = {
      title: "LOGO TEE",
      variant_title: "S",
      new_variant_title: "L",
      action: "CAMBIO",
      quantity: 1,
    };
    expect(exchangeFromProducts([amalfiExchange, plainReturn, tee])).toEqual({
      replacements: ["STAR AMALFI PANTS — Medium (40)", "LOGO TEE — L"],
    });
  });

  it("still reports an exchange when the new size is missing", () => {
    // Mixed basket: the copy must not silently downgrade to return-only wording
    // just because one replacement could not be named.
    const unnamed = { ...amalfiExchange, new_variant_title: null };
    expect(exchangeFromProducts([unnamed])).toEqual({ replacements: [] });
  });
});
