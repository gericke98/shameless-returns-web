// Seed shipping_fees from the carrier tariff committed at
// data/return-tariff.csv — one row per (destination, weight band).
//
// Supersedes seed-shipping-fees.ts, which wrote a single flat pair for '*' and
// 'ES' from the NEXT_PUBLIC_SHIPPING_* env vars and so charged the Spanish
// domestic rate at every destination and every weight.
//
// The tariff is read from a committed CSV rather than from Google Sheets at
// runtime, so a price change arrives as a reviewable diff and the values that
// produced a given charge are recoverable from git history.
//
// Run with: npx tsx scripts/seed-shipping-fees-by-country.ts [--dry-run]
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shippingFees } from "../db/schema";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS } from "../lib/fees";
import { ZONE_KEY_PATTERN } from "../lib/zones";

// db/drizzle opens the Neon connection at module scope, so importing it
// eagerly would make --dry-run require a DATABASE_URL it never uses. Loaded
// lazily instead, only on the path that actually writes.
const connect = async () => (await import("../db/drizzle")).default;

const HEADER =
  "country_code,zone,mode,max_grams,carrier_cost_cents,return_fee_cents,exchange_fee_cents";

type TariffRow = {
  countryCode: string;
  zone: string;
  mode: string;
  maxGrams: number;
  carrierCostCents: number;
  returnFeeCents: number;
  exchangeFeeCents: number;
};

function parseTariff(): TariffRow[] {
  const csv = readFileSync(join(process.cwd(), "data", "return-tariff.csv"), "utf8");
  const [header, ...lines] = csv.trim().split("\n");

  // Fail loudly on a reshaped file rather than silently seeding wrong columns —
  // these values are what customers get charged.
  if (header.trim() !== HEADER) {
    throw new Error(
      `data/return-tariff.csv header changed.\n  expected: ${HEADER}\n  found:    ${header}`
    );
  }

  const rows = lines.filter(Boolean).map((line, i) => {
    const [countryCode, zone, mode, maxGrams, cost, ret, exc] = line.split(",");
    const row: TariffRow = {
      countryCode: countryCode?.trim(),
      zone: zone?.trim(),
      mode: mode?.trim(),
      maxGrams: Number(maxGrams),
      carrierCostCents: Number(cost),
      returnFeeCents: Number(ret),
      exchangeFeeCents: Number(exc),
    };
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v))) {
        throw new Error(`data/return-tariff.csv line ${i + 2}: bad ${k} in "${line}"`);
      }
    }
    // Not strictly ISO-2: Spain's islands and enclaves are their own zones
    // (ES-IB, ES-CN, ES-CM) because the carrier prices them separately.
    if (!ZONE_KEY_PATTERN.test(row.countryCode) || row.countryCode === DEFAULT_FEE_KEY) {
      throw new Error(
        `data/return-tariff.csv line ${i + 2}: "${row.countryCode}" is not a valid zone key`
      );
    }
    return row;
  });

  // A country whose heaviest band stops short of UNBOUNDED_MAX_GRAMS leaves
  // every parcel above it unpriced. feesForWeight would fall back to the
  // heaviest band, which is survivable but silent — catch it here instead.
  const byCountry = new Map<string, TariffRow[]>();
  for (const row of rows) {
    const list = byCountry.get(row.countryCode) ?? [];
    list.push(row);
    byCountry.set(row.countryCode, list);
  }
  for (const [countryCode, bands] of Array.from(byCountry.entries())) {
    if (!bands.some((b: TariffRow) => b.maxGrams === UNBOUNDED_MAX_GRAMS)) {
      throw new Error(
        `${countryCode} has no unbounded band — a heavy enough parcel would be unpriced`
      );
    }
  }

  return rows;
}

/**
 * Bands for the '*' row — every destination NOT listed in the tariff.
 *
 * The most expensive fee seen at each band, across every country. Derived
 * rather than chosen, because the alternative is a hand-picked constant that
 * silently goes stale the next time the carrier republishes.
 *
 * Erring expensive is deliberate. The '*' row used to be 500/400 — the
 * cheapest in the tariff — so the moment Shopify accepted an order from a
 * market we had not priced, its returns shipped at the largest possible loss,
 * silently. An unlisted destination should announce itself, not bleed.
 *
 * Known cost: Andorra is road-adjacent to Spain and would realistically be
 * cheap, but it appears in neither tariff tab and so lands here. It has never
 * received an order; revisit if that changes or the carrier quotes it.
 */
function defaultBands(rows: TariffRow[]) {
  const byBand = new Map<number, { returnFeeCents: number; exchangeFeeCents: number }>();
  for (const row of rows) {
    const current = byBand.get(row.maxGrams);
    byBand.set(row.maxGrams, {
      returnFeeCents: Math.max(current?.returnFeeCents ?? 0, row.returnFeeCents),
      exchangeFeeCents: Math.max(current?.exchangeFeeCents ?? 0, row.exchangeFeeCents),
    });
  }
  return Array.from(byBand.entries())
    .sort(([a], [b]) => a - b)
    .map(([maxGrams, fees]) => ({ countryCode: DEFAULT_FEE_KEY, maxGrams, ...fees }));
}

const kg = (grams: number) =>
  grams >= UNBOUNDED_MAX_GRAMS ? "  any" : `${(grams / 1000).toFixed(1)}kg`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rows = parseTariff();

  const all = [
    ...rows.map((r) => ({
      countryCode: r.countryCode,
      maxGrams: r.maxGrams,
      returnFeeCents: r.returnFeeCents,
      exchangeFeeCents: r.exchangeFeeCents,
    })),
    ...defaultBands(rows),
  ];

  if (dryRun) {
    for (const row of all) {
      console.log(
        `would upsert ${row.countryCode.padEnd(2)} ${kg(row.maxGrams)}  ` +
          `return=${row.returnFeeCents}c exchange=${row.exchangeFeeCents}c`
      );
    }
    const countries = new Set(all.map((r) => r.countryCode)).size;
    console.log(`\ndry run: ${all.length} rows across ${countries} destinations, nothing written`);
    return;
  }

  const db = await connect();
  for (const row of all) {
    await db
      .insert(shippingFees)
      .values(row)
      .onConflictDoUpdate({
        // Both key columns. Targeting country_code alone no longer matches the
        // primary key, and would overwrite the wrong band if it did.
        target: [shippingFees.countryCode, shippingFees.maxGrams],
        set: {
          returnFeeCents: row.returnFeeCents,
          exchangeFeeCents: row.exchangeFeeCents,
          updatedAt: new Date(),
        },
      });
  }

  const countries = new Set(all.map((r) => r.countryCode)).size;
  console.log(`${all.length} rows written across ${countries} destinations`);
  // No revalidateTag from a plain script — getFeeTable's 300s ceiling picks
  // these up within five minutes. Publish through the dashboard if you need
  // a price live immediately.
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
