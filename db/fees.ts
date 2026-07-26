// NOT a "use server" module. db/queries.ts carries "use server", which forces
// every export there to be an async server action; this file needs to export
// a plain constant alongside its reader, and is only ever imported by server
// components and server actions.
import { unstable_cache } from "next/cache";
import db from "./drizzle";
import { shippingFees } from "./schema";
import type { CountryFees, FeeTable } from "@/lib/fees";

export const SHIPPING_FEES_TAG = "shipping-fees";

/**
 * Read every fee row into a lookup keyed by country code (plus the '*'
 * default). Cached and tagged so rendering does not hit the DB per request;
 * the admin save action calls revalidateTag(SHIPPING_FEES_TAG) to publish a
 * price change without a deploy.
 */
export const getFeeTable = unstable_cache(
  async (): Promise<FeeTable> => {
    const rows = await db.select().from(shippingFees);
    const table: Record<string, CountryFees> = {};
    for (const row of rows) {
      table[row.countryCode] = {
        returnFeeCents: row.returnFeeCents,
        exchangeFeeCents: row.exchangeFeeCents,
      };
    }
    return table;
  },
  ["shipping-fees-table"],
  { tags: [SHIPPING_FEES_TAG] }
);
