import { describe, expect, it } from "vitest";
import { EU_ISO2, SUPPORTED_COUNTRIES, normalizeCountry } from "@/lib/countries";

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
});
