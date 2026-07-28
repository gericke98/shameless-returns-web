// Seed one shipping_fees row per destination we actually ship to, from the
// carrier tariff committed at data/return-tariff.csv.
//
// Supersedes seed-shipping-fees.ts, which wrote only '*' and 'ES' from the
// NEXT_PUBLIC_SHIPPING_* env vars and so left every international destination
// falling through to the Spanish domestic rate.
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
import { DEFAULT_FEE_KEY } from "../lib/fees";

// db/drizzle opens the Neon connection at module scope, so importing it
// eagerly would make --dry-run require a DATABASE_URL it never uses. Loaded
// lazily instead, only on the path that actually writes.
const connect = async () => (await import("../db/drizzle")).default;

type TariffRow = {
  countryCode: string;
  zone: string;
  mode: string;
  carrierCostCents: number;
  returnFeeCents: number;
  exchangeFeeCents: number;
};

function parseTariff(): TariffRow[] {
  const csv = readFileSync(join(process.cwd(), "data", "return-tariff.csv"), "utf8");
  const [header, ...lines] = csv.trim().split("\n");

  // Fail loudly on a reshaped file rather than silently seeding wrong columns —
  // these values are what customers get charged.
  const expected =
    "country_code,zone,mode,carrier_cost_1kg_cents,return_fee_cents,exchange_fee_cents";
  if (header.trim() !== expected) {
    throw new Error(`data/return-tariff.csv header changed.\n  expected: ${expected}\n  found:    ${header}`);
  }

  return lines.filter(Boolean).map((line, i) => {
    const [countryCode, zone, mode, cost, ret, exc] = line.split(",");
    const row = {
      countryCode: countryCode?.trim(),
      zone: zone?.trim(),
      mode: mode?.trim(),
      carrierCostCents: Number(cost),
      returnFeeCents: Number(ret),
      exchangeFeeCents: Number(exc),
    };
    for (const [k, v] of Object.entries(row)) {
      if (v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v))) {
        throw new Error(`data/return-tariff.csv line ${i + 2}: bad ${k} in "${line}"`);
      }
    }
    if (!/^[A-Z]{2}$/.test(row.countryCode)) {
      throw new Error(`data/return-tariff.csv line ${i + 2}: "${row.countryCode}" is not an ISO-2 code`);
    }
    return row;
  });
}

/**
 * Fees for the '*' row — every destination NOT listed in the tariff.
 *
 * TODO(santiago): decide this deliberately; it is the one value in this file
 * that is a policy call rather than a transcription of the carrier sheet.
 *
 * Today '*' is 500/400 — the Spanish domestic rate, i.e. the CHEAPEST row in
 * the whole tariff. That means the moment Shopify accepts an order from a
 * market we have not priced, its returns ship at the largest possible loss,
 * silently, until somebody notices. Andorra is already one such destination:
 * it is absent from both tariff tabs.
 *
 * The trade-off, concretely:
 *   - Cheap default  -> new markets are never blocked, and every one of them
 *                       loses money quietly. Current behaviour.
 *   - Expensive      -> an unpriced destination is obvious to the customer
 *     default           immediately (they see a high fee and complain), which
 *                       surfaces the gap fast, but overcharges a customer who
 *                       did nothing wrong.
 *
 * The most expensive tariff row is Israel at 8248 cents; the rest-of-world air
 * tier sits at 5268. Returning `{ returnFeeCents: 2500, exchangeFeeCents: 2400 }`
 * would put unlisted destinations in the same band as the other air routes.
 */
function defaultFees(): { returnFeeCents: number; exchangeFeeCents: number } | null {
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rows = parseTariff();
  const fallback = defaultFees();

  // Report the parsed tariff before demanding the policy call, so --dry-run is
  // useful while '*' is still undecided.
  if (dryRun) {
    for (const r of rows) {
      console.log(
        `would upsert ${r.countryCode} return=${r.returnFeeCents}c exchange=${r.exchangeFeeCents}c` +
          `  (${r.mode} ${r.zone}, carrier cost ${r.carrierCostCents}c)`
      );
    }
    console.log(`\n${rows.length} countries parsed from data/return-tariff.csv`);
  }

  if (!fallback) {
    throw new Error(
      `defaultFees() returns null — the '${DEFAULT_FEE_KEY}' row is undecided. ` +
        `See the TODO in this file; nothing has been written.`
    );
  }

  const all = [
    ...rows.map((r) => ({
      countryCode: r.countryCode,
      returnFeeCents: r.returnFeeCents,
      exchangeFeeCents: r.exchangeFeeCents,
    })),
    { countryCode: DEFAULT_FEE_KEY, ...fallback },
  ];

  if (dryRun) {
    console.log(
      `would upsert ${DEFAULT_FEE_KEY}  return=${fallback.returnFeeCents}c ` +
        `exchange=${fallback.exchangeFeeCents}c  (fallback for unlisted destinations)`
    );
    console.log(`\ndry run: ${all.length} rows, nothing written`);
    return;
  }

  const db = await connect();
  for (const row of all) {
    const label = `${row.countryCode.padEnd(2)} return=${row.returnFeeCents}c exchange=${row.exchangeFeeCents}c`;
    await db
      .insert(shippingFees)
      .values(row)
      .onConflictDoUpdate({
        target: shippingFees.countryCode,
        set: {
          returnFeeCents: row.returnFeeCents,
          exchangeFeeCents: row.exchangeFeeCents,
          updatedAt: new Date(),
        },
      });
    console.log(`upserted ${label}`);
  }

  console.log(`\n${all.length} rows written (${rows.length} countries + '${DEFAULT_FEE_KEY}')`);
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
