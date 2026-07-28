// NOT a "use server" module. db/queries.ts carries "use server", which forces
// every export there to be an async server action; this file needs to export
// a plain constant alongside its reader, and is only ever imported by server
// components and server actions.
import { unstable_cache } from "next/cache";
import db from "./drizzle";
import { shippingFees } from "./schema";
import type { FeeBand, FeeTable } from "@/lib/fees";

export const SHIPPING_FEES_TAG = "shipping-fees";

/**
 * Read every fee row into a lookup keyed by country code (plus the '*'
 * default). Cached and tagged so rendering does not hit the DB per request.
 *
 * Two independent invalidation paths, both needed:
 *  - `tags: [SHIPPING_FEES_TAG]` — the normal, immediate path. The admin
 *    save action calls revalidateTag(SHIPPING_FEES_TAG) right after writing
 *    shipping_fees, so a price change published through the dashboard is
 *    visible on the very next request.
 *  - `revalidate: 300` — a defence-in-depth ceiling for changes that bypass
 *    the tag entirely: a SQL edit in the Neon console, a psql session, a
 *    future backfill script. Without this, a stale price stays cached
 *    indefinitely and only a redeploy or runtime restart would clear it.
 *    Since these values determine what customers are charged, the cache
 *    self-heals within five minutes even in that abnormal case. This is a
 *    safety net, not the normal update path — it does not replace the tag.
 */
export const getFeeTable = unstable_cache(
  async (): Promise<FeeTable> => {
    const rows = await db.select().from(shippingFees);
    const table: Record<string, FeeBand[]> = {};
    for (const row of rows) {
      (table[row.countryCode] ??= []).push({
        maxGrams: row.maxGrams,
        returnFeeCents: row.returnFeeCents,
        exchangeFeeCents: row.exchangeFeeCents,
      });
    }
    // feesForWeight returns the first band a parcel fits, so ascending order
    // is a precondition rather than a nicety. Sorting here means neither the
    // query nor any caller has to remember it.
    for (const bands of Object.values(table)) {
      bands.sort((a, b) => a.maxGrams - b.maxGrams);
    }
    return table;
  },
  ["shipping-fees-table"],
  { tags: [SHIPPING_FEES_TAG], revalidate: 300 }
);
