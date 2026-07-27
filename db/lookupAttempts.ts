// The database half of the order-lookup rate limit. Policy lives in
// lib/rateLimit.ts, which stays pure; this file only counts, records and prunes.
//
// NOT a "use server" module: db/queries.ts carries that directive, which forces
// every export there to be an async action. These are plain helpers called from
// a server action.
import { and, eq, gte, lt, sql } from "drizzle-orm";
import db from "./drizzle";
import { lookupAttempts } from "./schema";
import { LOOKUP_WINDOW_MS, windowStart } from "@/lib/rateLimit";

/**
 * Failed attempts from this caller inside the current window.
 *
 * Returns -1 when the count cannot be established, which `exceedsLookupLimit`
 * treats as "not exceeding" — the limit fails OPEN. It is defence in depth on
 * top of the email match, and a database blip must not lock every customer out
 * of returns.
 */
export async function countRecentFailures(ip: string, now: number): Promise<number> {
  try {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(lookupAttempts)
      .where(
        and(eq(lookupAttempts.ip, ip), gte(lookupAttempts.attemptedAt, windowStart(now)))
      );
    return rows[0]?.count ?? 0;
  } catch (error) {
    console.error("countRecentFailures: failing open", error);
    return -1;
  }
}

/**
 * Record one failed attempt, and opportunistically drop rows that have fallen
 * out of the window so the table stays bounded without a scheduled job.
 *
 * Never throws: failing to record an attempt must not fail the lookup itself.
 */
export async function recordFailedAttempt(ip: string, now: number): Promise<void> {
  try {
    await db.insert(lookupAttempts).values({ ip });

    // Prune anything older than two windows — one window of slack so a row is
    // never removed while it could still count toward a live limit.
    await db
      .delete(lookupAttempts)
      .where(lt(lookupAttempts.attemptedAt, new Date(now - LOOKUP_WINDOW_MS * 2)));
  } catch (error) {
    console.error("recordFailedAttempt: could not record", error);
  }
}
