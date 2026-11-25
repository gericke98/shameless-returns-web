import "server-only";
// The shipping-fee table editor (F1 spec §4 `saveShippingFee`).
import { revalidateTag } from "next/cache";
import { z } from "zod";
import db from "@/db/drizzle";
import { SHIPPING_FEES_TAG } from "@/db/fees";
import { shippingFees } from "@/db/schema";
import { normalizeCountry } from "@/lib/countries";
import { DEFAULT_FEE_KEY } from "@/lib/fees";
import { SUB_ZONES } from "@/lib/zones";
import { ok, refuse, type HandlerResult } from "@/lib/actionResult";
import type { AdminContext } from "@/lib/server/actions";
import { parseEurosToCents } from "@/lib/server/parseEurosToCents";

export const saveShippingFeeInput = z
  .object({
    country: z.string().max(16),
    /** The band's upper bound in grams: part of the primary key. */
    band: z.number(),
    returnFee: z.string().max(32),
    exchangeFee: z.string().max(32),
  })
  .strict();

export async function saveShippingFeeHandler(
  _ctx: AdminContext,
  input: z.infer<typeof saveShippingFeeInput>
): Promise<HandlerResult<{}, "unsupported-destination" | "invalid-band" | "invalid-amount">> {
  // Sub-zones (ES-CN and friends) are not countries and would not survive
  // normalizeCountry, but they are legitimate fee-table keys — they are
  // resolved from the postal code rather than picked by the customer.
  const countryCode =
    input.country === DEFAULT_FEE_KEY || (SUB_ZONES as readonly string[]).includes(input.country)
      ? input.country
      : normalizeCountry(input.country);
  if (!countryCode) return refuse("unsupported-destination");

  // Part of the primary key, so a bad value would silently create a new band
  // rather than update the intended one.
  const maxGrams = input.band;
  if (!Number.isInteger(maxGrams) || maxGrams <= 0) return refuse("invalid-band");

  const returnFeeCents = parseEurosToCents(input.returnFee);
  const exchangeFeeCents = parseEurosToCents(input.exchangeFee);
  if (returnFeeCents === null || exchangeFeeCents === null) return refuse("invalid-amount");

  // A failed upsert throws to the factory: logged, alerted, answered `failed`,
  // never with raw DB text. revalidateTag runs only after a write that landed.
  await db
    .insert(shippingFees)
    .values({ countryCode, maxGrams, returnFeeCents, exchangeFeeCents, updatedAt: new Date() })
    .onConflictDoUpdate({
      // Must name both key columns. Targeting country_code alone no longer
      // matches the primary key, so the upsert would raise instead of
      // updating — and if it did match, it would overwrite the wrong band.
      target: [shippingFees.countryCode, shippingFees.maxGrams],
      set: { returnFeeCents, exchangeFeeCents, updatedAt: new Date() },
    });

  revalidateTag(SHIPPING_FEES_TAG);
  return ok({});
}
