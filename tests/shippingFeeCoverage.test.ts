import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { UNBOUNDED_MAX_GRAMS } from "@/lib/fees";

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
  maxGrams: number;
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
      const [countryCode, , , maxGrams, cost, ret, exc] = line.split(",");
      return {
        countryCode,
        maxGrams: Number(maxGrams),
        carrierCostCents: Number(cost),
        returnFeeCents: Number(ret),
        exchangeFeeCents: Number(exc),
      };
    });
}

function bandsByCountry(tariff: TariffRow[]) {
  const map = new Map<string, TariffRow[]>();
  for (const row of tariff) {
    const list = map.get(row.countryCode) ?? [];
    list.push(row);
    map.set(row.countryCode, list);
  }
  for (const list of Array.from(map.values())) {
    list.sort((a, b) => a.maxGrams - b.maxGrams);
  }
  return map;
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

  it("gives every destination an unbounded top band", () => {
    // Without one, a heavy enough parcel matches no band. feesForWeight would
    // fall back to the heaviest, which is survivable but silent — and the
    // silence is the problem, since it undercharges exactly the parcels that
    // cost the most to ship.
    const missing = Array.from(bandsByCountry(tariff).entries())
      .filter(([, bands]) => !bands.some((b) => b.maxGrams === UNBOUNDED_MAX_GRAMS))
      .map(([countryCode]) => countryCode);

    expect(missing, `no unbounded band: ${missing.join(", ")}`).toEqual([]);
  });

  it("never charges less for a heavier parcel to the same destination", () => {
    for (const [countryCode, bands] of Array.from(bandsByCountry(tariff).entries())) {
      for (let i = 1; i < bands.length; i++) {
        expect(
          bands[i].returnFeeCents,
          `${countryCode}: ${bands[i].maxGrams}g cheaper than ${bands[i - 1].maxGrams}g`
        ).toBeGreaterThanOrEqual(bands[i - 1].returnFeeCents);
      }
    }
  });

  it("gives every destination the same set of bands", () => {
    // Uniform bands keep the dashboard a rectangle and make "is X pricier
    // than Y" answerable. A country with its own thresholds would still work
    // at runtime, but nobody would notice it drifting.
    const shapes = new Set(
      Array.from(bandsByCountry(tariff).values()).map((bands) =>
        bands.map((b) => b.maxGrams).join("|")
      )
    );
    expect(Array.from(shapes)).toHaveLength(1);
  });

  it("never prices a cheaper destination above a more expensive one", () => {
    // Holds because every fee is the carrier's own cost rounded up to the
    // whole euro, and ceil is monotonic. It did NOT hold under the earlier
    // scheme, which banded the <=1kg fee into four tiers and then added raw
    // increments on top: that flattening let AE (cost 6695 at 2kg) come out
    // cheaper than MX (cost 6635). Charging cost directly removes the class
    // of bug rather than papering over the instance.
    const byBand = new Map<number, TariffRow[]>();
    for (const row of tariff) {
      byBand.set(row.maxGrams, [...(byBand.get(row.maxGrams) ?? []), row]);
    }

    for (const [maxGrams, rows] of Array.from(byBand.entries())) {
      const sorted = rows.sort((a, b) => a.carrierCostCents - b.carrierCostCents);
      for (let i = 1; i < sorted.length; i++) {
        expect(
          sorted[i].returnFeeCents,
          `at ${maxGrams}g: ${sorted[i].countryCode} (cost ${sorted[i].carrierCostCents}) ` +
            `charged less than ${sorted[i - 1].countryCode} (cost ${sorted[i - 1].carrierCostCents})`
        ).toBeGreaterThanOrEqual(sorted[i - 1].returnFeeCents);
      }
    }
  });

  it("covers the carrier's cost on every return", () => {
    // The whole point of charging cost: no row may be below it. Exchanges keep
    // the historical EUR 1.00 discount and so are allowed to sit just under.
    for (const row of tariff) {
      expect(
        row.returnFeeCents,
        `${row.countryCode} at ${row.maxGrams}g is below carrier cost`
      ).toBeGreaterThanOrEqual(row.carrierCostCents);
    }
  });

  it("keeps peninsular Spain the cheapest destination in every band", () => {
    // The one ordering that is a business invariant rather than an artefact:
    // domestic must never cost more than international.
    const byBand = bandsByCountry(tariff);
    const spain = byBand.get("ES");
    expect(spain, "ES must be priced").toBeDefined();

    for (const [countryCode, bands] of Array.from(byBand.entries())) {
      if (countryCode === "ES") continue;
      bands.forEach((band, i) => {
        expect(
          band.returnFeeCents,
          `${countryCode} band ${band.maxGrams}g is cheaper than ES`
        ).toBeGreaterThanOrEqual(spain![i].returnFeeCents);
      });
    }
  });
});
