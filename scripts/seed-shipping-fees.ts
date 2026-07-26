// One-shot seed. Writes the '*' default and the 'ES' row from the values the
// app currently uses, so introducing the table changes no prices. Safe to
// re-run: it upserts.
//
// Run with: npx tsx scripts/seed-shipping-fees.ts
import "dotenv/config";
import db from "../db/drizzle";
import { shippingFees } from "../db/schema";

async function main() {
  const returnEuros = Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST);
  const exchangeEuros = Number(process.env.NEXT_PUBLIC_SHIPPING_EXCHANGE_COST);

  if (!Number.isFinite(returnEuros) || !Number.isFinite(exchangeEuros)) {
    throw new Error(
      "NEXT_PUBLIC_SHIPPING_RETURN_COST / NEXT_PUBLIC_SHIPPING_EXCHANGE_COST must be set to seed from current prices"
    );
  }

  const returnCents = Math.round(returnEuros * 100);
  const exchangeCents = Math.round(exchangeEuros * 100);

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
        set: { returnFeeCents: returnCents, exchangeFeeCents: exchangeCents },
      });
    console.log(`seeded ${countryCode}: return=${returnCents}c exchange=${exchangeCents}c`);
  }
}

main().then(() => process.exit(0));
