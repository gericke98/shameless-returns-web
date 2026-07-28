import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  SUPPORTED_COUNTRIES,
  countryDisplayName,
  normalizeCountry,
} from "@/lib/countries";
import { UNBOUNDED_MAX_GRAMS, feesForCountry } from "@/lib/fees";

// `db/queries.ts` wraps a query in React's `cache()`, which is only resolvable
// under Next.js's "react-server" module condition (its own build pipeline).
// Plain vitest/node resolves the default "react" export, which does not
// include `cache` in this React 18 build. The two tests below import
// actions/amphoraReturn.ts, which transitively
// import db/queries.ts purely to reach `getOrderById`/`getVariantSkusByIds` —
// neither is called by the functions under test. Stub `cache` as a pass-through
// so the module graph loads; no behavior under test depends on memoization.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

// Cut the expensive half of that import graph away entirely.
//
// actions/amphoraReturn.ts imports db/drizzle,
// which calls neon(process.env.DATABASE_URL!) at MODULE SCOPE, plus db/queries,
// which loads the Shopify Node adapter. Resolving all of that made this file
// (a) require a DATABASE_URL just to import, and (b) intermittently blow the 5s
// default timeout under full-suite parallel load — roughly 1 run in 4.
//
// The function under test — isInternationalOrder — is
// pure string functions. They touch none of it.
vi.mock("@/db/drizzle", () => ({ default: {} }));
vi.mock("@/db/queries", () => ({
  getOrderById: async () => null,
  getVariantSkusByIds: async () => [],
}));

describe("normalizeCountry", () => {
  it("accepts an ISO-2 code in any case", () => {
    expect(normalizeCountry("ES")).toBe("ES");
    expect(normalizeCountry("es")).toBe("ES");
    expect(normalizeCountry(" fr ")).toBe("FR");
  });

  it("accepts the English display name Shopify sends", () => {
    expect(normalizeCountry("Spain")).toBe("ES");
    expect(normalizeCountry("France")).toBe("FR");
    expect(normalizeCountry("Czech Republic")).toBe("CZ");
  });

  it("accepts the Spanish display name", () => {
    expect(normalizeCountry("España")).toBe("ES");
    expect(normalizeCountry("Espana")).toBe("ES");
    expect(normalizeCountry("Francia")).toBe("FR");
  });

  it("returns null for empty or unknown input", () => {
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry("   ")).toBeNull();
    expect(normalizeCountry("Atlantis")).toBeNull();
    expect(normalizeCountry("ZZ")).toBeNull();
  });

  it("resolves 2-char aliases to their countries", () => {
    // Test that 2-char strings fall through to name lookup when not valid codes
    expect(normalizeCountry("uk")).toBe("GB");
    expect(normalizeCountry("UK")).toBe("GB");
    expect(normalizeCountry("usa")).toBe("US");
    expect(normalizeCountry("USA")).toBe("US");
    // Unknown 2-char codes still return null
    expect(normalizeCountry("ZZ")).toBeNull();
    expect(normalizeCountry("XX")).toBeNull();
  });

  it("every supported country round-trips through its own names", () => {
    for (const c of SUPPORTED_COUNTRIES) {
      expect(normalizeCountry(c.code)).toBe(c.code);
      expect(normalizeCountry(c.nameEn)).toBe(c.code);
      expect(normalizeCountry(c.nameEs)).toBe(c.code);
    }
  });

  it("names the non-EU destinations the dropdown offers", () => {
    for (const code of ["AD", "IS", "JP", "BR", "IL", "AE", "CO"]) {
      expect(
        SUPPORTED_COUNTRIES.some((c) => c.code === code),
        `${code} should be nameable`
      ).toBe(true);
    }
  });

  it("resolves Andorra rather than falling through to Spain", () => {
    expect(normalizeCountry("Andorra")).toBe("AD");
    expect(normalizeCountry("AD")).toBe("AD");
  });

  it("gives every supported country a distinct code", () => {
    const codes = SUPPORTED_COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("countryDisplayName", () => {
  it("localizes a recognised stored country", () => {
    expect(countryDisplayName("ES", "es")).toBe("España");
    expect(countryDisplayName("Spain", "en")).toBe("Spain");
    expect(countryDisplayName("Andorra", "es")).toBe("Andorra");
    expect(countryDisplayName("JP", "en")).toBe("Japan");
  });

  it("shows an unnameable stored country verbatim, never Spain", () => {
    // The address form renders this value read-only. Substituting a default
    // here is exactly the bug: it would tell the customer their Wakandan
    // order is going to Spain, and Spain is what the carrier would see.
    expect(countryDisplayName("Wakanda", "es")).toBe("Wakanda");
    expect(countryDisplayName("Wakanda", "en")).toBe("Wakanda");
    expect(countryDisplayName(null, "es")).toBe("");
  });
});

describe("an unnameable stored country still routes and prices safely", () => {
  it("counts as international, so Amphora still handles it", async () => {
    const { isInternationalOrder } = await import("@/actions/amphoraReturn");
    expect(normalizeCountry("Wakanda")).toBeNull();
    expect(isInternationalOrder("Wakanda")).toBe(true);
  });

  it("falls back to the '*' fee row rather than the ES row", () => {
    const band = (returnFeeCents: number) => [
      { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents: 0 },
    ];
    const table = { "*": band(995), ES: band(399) };
    expect(feesForCountry(table, normalizeCountry("Wakanda"))).toEqual(
      table["*"]
    );
    // And a country we *can* name still has the option of its own row.
    expect(feesForCountry(table, normalizeCountry("Andorra"))).toEqual(
      table["*"]
    );
    expect(
      feesForCountry(
        { ...table, AD: band(700) },
        normalizeCountry("Andorra")
      )[0].returnFeeCents
    ).toBe(700);
  });

  it("is never written back from the address form", () => {
    // The country is display-only in secondWindowForm. updateData must not
    // read a `country` field at all — that is what makes it impossible for a
    // stored country to be replaced by a client-supplied one.
    const source = readFileSync(
      resolve(__dirname, "../actions/updateOrder.ts"),
      "utf-8"
    );
    expect(source).not.toContain('formData.get("country")');
    expect(source).not.toContain("shippingCountry:");
  });
});

describe("lib/countries source hygiene", () => {
  it("uses explicit unicode escape sequences in the regex (not literal combining characters)", () => {
    // Read the source file and verify the regex uses \\u0300-\\u036f notation,
    // not the actual U+0300..U+036F characters (which are invisible and corrupt on copy).
    const sourceFile = readFileSync(resolve(__dirname, "../lib/countries.ts"), "utf-8");

    // Must contain the escape sequence notation
    expect(sourceFile).toContain("\\u0300-\\u036f");

    // Must NOT contain the actual combining characters U+0300–U+036F range
    // (this would indicate the regex was created from literal chars, not escapes)
    const combinedMarkRange = /[̀-ͯ]/;
    expect(sourceFile).not.toMatch(combinedMarkRange);
  });
});

describe("country helpers keep their previous semantics", () => {
  it("treats Spain in every stored spelling as national", async () => {
    const { isInternationalOrder } = await import("@/actions/amphoraReturn");
    for (const spelling of ["Spain", "España", "Espana", "ES", "es", "esp"]) {
      expect(isInternationalOrder(spelling)).toBe(false);
    }
  });

  it("treats empty as not international, matching the old guard", async () => {
    const { isInternationalOrder } = await import("@/actions/amphoraReturn");
    expect(isInternationalOrder("")).toBe(false);
    expect(isInternationalOrder(null)).toBe(false);
  });

});
