import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, formatEuros, readLocale } from "@/lib/i18n";

describe("readLocale", () => {
  it("passes through the two supported locales", () => {
    expect(readLocale("es")).toBe("es");
    expect(readLocale("en")).toBe("en");
  });

  it("defaults unrecognised, missing, or attacker-controlled values to es", () => {
    // Pinned to the literal "es", not just DEFAULT_LOCALE: the requirement is
    // that an absent/bad cookie yields Spanish specifically. Asserting only
    // against the imported constant would stay green even if DEFAULT_LOCALE
    // were changed to "en", which would silently violate the spec.
    expect(readLocale(undefined)).toBe("es");
    expect(readLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(readLocale(null)).toBe(DEFAULT_LOCALE);
    expect(readLocale("")).toBe(DEFAULT_LOCALE);
    expect(readLocale("fr")).toBe(DEFAULT_LOCALE);
    expect(readLocale("ES")).toBe(DEFAULT_LOCALE); // case-sensitive, not just "any known locale"
    expect(readLocale("es; DROP TABLE orders;--")).toBe(DEFAULT_LOCALE);
  });
});

describe("formatEuros", () => {
  it("renders Spanish grouping/decimal conventions for es", () => {
    expect(formatEuros(4, "es")).toBe("4,00 €");
  });

  it("renders Irish (euro, not US) grouping/decimal conventions for en", () => {
    expect(formatEuros(4, "en")).toBe("€4.00");
  });

  it("formats larger amounts with locale-correct thousands separators", () => {
    expect(formatEuros(1234.5, "es")).toBe("1234,50 €");
    expect(formatEuros(1234.5, "en")).toBe("€1,234.50");
  });
});
