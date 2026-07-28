"use server";

import db from "@/db/drizzle";
import { SHIPPING_FEES_TAG } from "@/db/fees";
import { shippingFees } from "@/db/schema";
import { normalizeCountry } from "@/lib/countries";
import { DEFAULT_FEE_KEY } from "@/lib/fees";
import { isAdmin } from "@/lib/requireAdmin";
import { revalidateTag } from "next/cache";
import { parseEurosToCents } from "./parseEurosToCents";

export async function saveShippingFee(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  // middleware.ts guards the /dashboard route, but a server action is its own
  // entry point and is not covered by route middleware. See lib/requireAdmin.
  if (!(await isAdmin())) {
    return { ok: false, error: "Not authorised" };
  }

  const rawCountry = String(formData.get("countryCode") ?? "");
  const countryCode =
    rawCountry === DEFAULT_FEE_KEY ? DEFAULT_FEE_KEY : normalizeCountry(rawCountry);
  if (!countryCode) {
    return { ok: false, error: `Unsupported country: ${rawCountry}` };
  }

  // Part of the primary key, so a bad value would silently create a new band
  // rather than update the intended one.
  const maxGrams = Number(formData.get("maxGrams"));
  if (!Number.isInteger(maxGrams) || maxGrams <= 0) {
    return { ok: false, error: "Weight band is missing or invalid" };
  }

  const returnFeeCents = parseEurosToCents(String(formData.get("returnFee") ?? ""));
  const exchangeFeeCents = parseEurosToCents(String(formData.get("exchangeFee") ?? ""));
  if (returnFeeCents === null || exchangeFeeCents === null) {
    return { ok: false, error: "Fees must be a non-negative amount with at most 2 decimals" };
  }

  try {
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
  } catch (err) {
    // Log the real error server-side for a diagnosable trail, but don't leak
    // raw DB error text (connection strings, constraint names, etc.) to the
    // client. revalidateTag must stay out of this catch block: it must never
    // fire against a write that did not land.
    console.error("saveShippingFee: upsert failed", { countryCode, maxGrams, err });
    return { ok: false, error: "Could not save this fee. Please try again." };
  }

  revalidateTag(SHIPPING_FEES_TAG);
  return { ok: true };
}
