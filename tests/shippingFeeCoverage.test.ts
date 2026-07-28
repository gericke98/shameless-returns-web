import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";

// Guards the gap that shipped to production once already: shipping_fees held
// only '*' and 'ES', so every international destination was charged the
// Spanish domestic rate. These tests fail the build if a country can be
// selected in the storefront without a deliberate price behind it.

/**
 * Destinations offered in the dropdown that we knowingly do not price.
 *
 * Andorra appears in neither tab of the carrier tariff, so there is no cost to
 * transcribe. It falls through to the '*' row until someone gets a quote.
 * Adding an entry here is a decision, not a workaround — anything listed is
 * billed at the fallback rate.
 */
const UNPRICED_BY_DECISION = new Set(["AD"]);

type TariffRow = {
  countryCode: string;
  carrierCostCents: number;
  returnFeeCents: number;
  exchangeFeeCents: number;
};

function readTariff(): TariffRow[] {
  const csv = readFileSync(resolve(process.cwd(), "data/return-tariff.csv"), "utf8");
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [countryCode, , , cost, ret, exc] = line.split(",");
      return {
        countryCode,
        carrierCostCents: Number(cost),
        returnFeeCents: Number(ret),
        exchangeFeeCents: Number(exc),
      };
    });
}

describe("shipping fee coverage", () => {
  const tariff = readTariff();
  const priced = new Set(tariff.map((r) => r.countryCode));

  it("prices every country offered in the storefront", () => {
    const missing = SUPPORTED_COUNTRIES.map((c) => c.code)
      .filter((code) => !priced.has(code))
      .filter((code) => !UNPRICED_BY_DECISION.has(code));

    expect(missing, `unpriced destinations: ${missing.join(", ")}`).toEqual([]);
  });

  it("offers every priced country in the storefront", () => {
    // The inverse gap is just as real: Uruguay received orders while absent
    // from SUPPORTED_COUNTRIES, so it shipped but could not be selected.
    const supported = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));
    const orphaned = Array.from(priced).filter((code) => !supported.has(code));

    expect(orphaned, `priced but not selectable: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("uses ISO-2 codes and positive integer cents throughout", () => {
    for (const row of tariff) {
      expect(row.countryCode).toMatch(/^[A-Z]{2}$/);
      for (const field of ["carrierCostCents", "returnFeeCents", "exchangeFeeCents"] as const) {
        expect(Number.isInteger(row[field]), `${row.countryCode}.${field}`).toBe(true);
        expect(row[field], `${row.countryCode}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the exchange fee below the return fee", () => {
    // The flat rates encoded a EUR 1.00 exchange discount (500/400) as a
    // retention incentive. Banding must not silently invert it.
    for (const row of tariff) {
      expect(row.exchangeFeeCents, row.countryCode).toBeLessThan(row.returnFeeCents);
    }
  });

  it("never prices a cheaper destination above a more expensive one", () => {
    // Bands are derived from carrier cost, so the mapping must stay monotonic:
    // if A costs less than B to ship, A must not be charged more than B.
    const sorted = [...tariff].sort((a, b) => a.carrierCostCents - b.carrierCostCents);
    for (let i = 1; i < sorted.length; i++) {
      expect(
        sorted[i].returnFeeCents,
        `${sorted[i].countryCode} (cost ${sorted[i].carrierCostCents}) charged less than ` +
          `${sorted[i - 1].countryCode} (cost ${sorted[i - 1].carrierCostCents})`
      ).toBeGreaterThanOrEqual(sorted[i - 1].returnFeeCents);
    }
  });
});
