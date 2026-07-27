// One-shot seed. Writes the '*' default and the 'ES' row from the values the
// app currently uses, so introducing the table changes no prices. Safe to
// re-run: it upserts.
//
// Run with: npx tsx scripts/seed-shipping-fees.ts
import "dotenv/config";
import db from "../db/drizzle";
import { shippingFees } from "../db/schema";
import { parseFeeCents } from "./parseFeeCents";

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
        returnFeeCents: returnCents,
        exchangeFeeCents: exchangeCents,
      })
      .onConflictDoUpdate({
        target: shippingFees.countryCode,
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
