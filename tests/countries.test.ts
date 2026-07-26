import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { EU_ISO2, SUPPORTED_COUNTRIES, normalizeCountry } from "@/lib/countries";

// `db/queries.ts` wraps a query in React's `cache()`, which is only resolvable
// under Next.js's "react-server" module condition (its own build pipeline).
// Plain vitest/node resolves the default "react" export, which does not
// include `cache` in this React 18 build. The two tests below import
// actions/amphoraReturn.ts and actions/sendcloudReturn.ts, which transitively
// import db/queries.ts purely to reach `getOrderById`/`getVariantSkusByIds` —
// neither is called by the functions under test. Stub `cache` as a pass-through
// so the module graph loads; no behavior under test depends on memoization.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

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

  it("keeps the EU set free of Spain", () => {
    expect(EU_ISO2.has("ES")).toBe(false);
    expect(EU_ISO2.has("FR")).toBe(true);
    expect(EU_ISO2.has("GB")).toBe(false);
  });

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

  it("keeps Spain and non-EU out of the Sendcloud EU lane", async () => {
    const { euIso2ForReturn } = await import("@/actions/sendcloudReturn");
    expect(euIso2ForReturn("Spain")).toBeNull();
    expect(euIso2ForReturn("United Kingdom")).toBeNull();
    expect(euIso2ForReturn("France")).toBe("FR");
    expect(euIso2ForReturn("Portugal")).toBe("PT");
  });
});
