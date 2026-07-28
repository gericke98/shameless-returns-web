import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { UNBOUNDED_MAX_GRAMS } from "@/lib/fees";
import { SUB_ZONES, ZONE_KEY_PATTERN } from "@/lib/zones";

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
    //
    // Sub-zones are compared on their parent country. ES-CN is not a country
    // a customer picks — it is resolved from the postal code of an address
    // already in Spain.
    const supported = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));
    const orphaned = Array.from(priced)
      .map((code) => code.split("-")[0])
      .filter((code) => !supported.has(code));

    expect(orphaned, `priced but not selectable: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("prices every sub-zone resolveZone can return", () => {
    // A zone the resolver produces but the tariff does not price would fall
    // through to '*' — which is the worst-case air rate, so a customer in
    // Mallorca would be billed as if their parcel were flying to Israel.
    const missing = SUB_ZONES.filter((zone) => !priced.has(zone));
    expect(missing, `resolvable but unpriced: ${missing.join(", ")}`).toEqual([]);
  });

  it("prices every Spanish sub-zone above peninsular Spain", () => {
    // The whole point: islands and enclaves cost more to reach. If a sub-zone
    // ever came out at or below peninsular, it would be cheaper to declare an
    // island address than a Madrid one.
    const byZone = bandsByCountry(tariff);
    const peninsular = byZone.get("ES")!;
    for (const zone of SUB_ZONES) {
      byZone.get(zone)!.forEach((band, i) => {
        expect(
          band.returnFeeCents,
          `${zone} at ${band.maxGrams}g is not dearer than peninsular ES`
        ).toBeGreaterThan(peninsular[i].returnFeeCents);
      });
    }
  });

  it("uses valid zone keys and positive integer cents throughout", () => {
    for (const row of tariff) {
      // ISO-2, or COUNTRY-XX for a sub-zone like ES-CN.
      expect(row.countryCode).toMatch(ZONE_KEY_PATTERN);
      for (const field of ["carrierCostCents", "returnFeeCents", "exchangeFeeCents"] as const) {
        expect(Number.isInteger(row[field]), `${row.countryCode}.${field}`).toBe(true);
        expect(row[field], `${row.countryCode}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it("charges more for an exchange than for a return", () => {
    // An exchange is TWO journeys — the parcel back and the replacement out —
    // against a return's one. The old flat rates had this backwards, charging
    // EUR 1 LESS for the exchange, which made the two-leg trip the cheaper of
    // the two and left every exchange short by a whole delivery.
    for (const row of tariff) {
      expect(
        row.exchangeFeeCents,
        `${row.countryCode} at ${row.maxGrams}g charges no more to also ship a replacement`
      ).toBeGreaterThan(row.returnFeeCents);
    }
  });

  it("adds the same outbound delivery at every weight", () => {
    // Outbound is a flat per-zone delivery price, so the gap between the
    // return and exchange fee must not vary with the parcel's weight. A
    // difference here means the two legs got entangled.
    for (const [countryCode, bands] of Array.from(bandsByCountry(tariff).entries())) {
      const deltas = new Set(bands.map((b) => b.exchangeFeeCents - b.returnFeeCents));
      expect(
        Array.from(deltas),
        `${countryCode} adds a different outbound cost per band`
      ).toHaveLength(1);
    }
  });

  it("matches the committed outbound rates", () => {
    // The exchange fee is return + outbound, so it must reconcile against the
    // rates outbound.mjs pulled from Shopify. Catches the two files drifting
    // apart when one is regenerated and the other is not.
    const outbound = new Map(
      readFileSync(resolve(process.cwd(), "data/outbound-rates.csv"), "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => {
          const cols = line.split(",");
          return [cols[0], Number(cols[4])] as const;
        })
    );
    for (const row of tariff) {
      expect(
        row.exchangeFeeCents - row.returnFeeCents,
        `${row.countryCode} does not match data/outbound-rates.csv`
      ).toBe(outbound.get(row.countryCode));
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
