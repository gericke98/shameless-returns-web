// SUPERSEDED by scripts/seed-shipping-fees-by-country.ts. Kept only as the
// record of where the original flat rates came from; it already refuses to run
// because NEXT_PUBLIC_SHIPPING_RETURN_COST and _EXCHANGE_COST no longer exist
// in any environment.
//
// Do not resurrect it. It writes a single unbounded band per country at one
// flat price, which would erase the per-country and per-weight rows the
// replacement seeds.
//
// One-shot seed. Writes the '*' default and the 'ES' row from the values the
// app currently uses, so introducing the table changes no prices. Safe to
// re-run: it upserts.
//
// Run with: npx tsx scripts/seed-shipping-fees.ts
import "dotenv/config";
import db from "../db/drizzle";
import { shippingFees } from "../db/schema";
import { parseFeeCents } from "./parseFeeCents";
import { UNBOUNDED_MAX_GRAMS } from "../lib/fees";

async function main() {
  const returnCents = parseFeeCents(
    process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST,
    "NEXT_PUBLIC_SHIPPING_RETURN_COST"
  );
  const exchangeCents = parseFeeCents(
    process.env.NEXT_PUBLIC_SHIPPING_EXCHANGE_COST,
    "NEXT_PUBLIC_SHIPPING_EXCHANGE_COST"
  );

  for (const countryCode of ["*", "ES"]) {
    await db
      .insert(shippingFees)
      .values({
        countryCode,
        maxGrams: UNBOUNDED_MAX_GRAMS,
        returnFeeCents: returnCents,
        exchangeFeeCents: exchangeCents,
      })
      .onConflictDoUpdate({
        target: [shippingFees.countryCode, shippingFees.maxGrams],
        set: {
          returnFeeCents: returnCents,
          exchangeFeeCents: exchangeCents,
          updatedAt: new Date(),
        },
      });
    console.log(`seeded ${countryCode}: return=${returnCents}c exchange=${exchangeCents}c`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
