// The database half of the ops-alert outbox. Delivery policy lives in
// actions/opsAlertOutbox.ts; this file only inserts, claims and marks rows.
//
// NOT a "use server" module, for the same reason as db/lookupAttempts.ts.
import { eq, sql } from "drizzle-orm";
import db from "./drizzle";
import { opsAlerts } from "./schema";

export type PendingOpsAlert = {
  id: string;
  dedupeKey: string;
  subject: string;
  body: string;
};

/** How long a claimed row is invisible to other dispatchers. Far above the
 *  5 s Postmark timeout, far below the 15-minute cron interval. */
export const OPS_ALERT_LEASE_SECONDS = 300;

/** Insert unless a row with this dedupe key already exists. True if inserted. */
export async function insertOpsAlert(alert: {
  dedupeKey: string;
  subject: string;
  body: string;
}): Promise<boolean> {
  const rows = await db
    .insert(opsAlerts)
    .values(alert)
    .onConflictDoNothing({ target: opsAlerts.dedupeKey })
    .returning({ id: opsAlerts.id });
  return rows.length > 0;
}

/**
 * Claim up to `limit` undelivered rows in ONE statement, stamping
 * `last_attempt_at` as the lease. `SKIP LOCKED` plus the lease mean two
 * dispatchers running at once never claim the same row, and a dispatcher that
 * dies mid-send releases its rows when the lease runs out.
 *
 * Never-attempted rows first, then the longest-waiting retry, so one alert that
 * keeps failing cannot starve the rest.
 */
export async function claimPendingOpsAlerts(limit: number): Promise<PendingOpsAlert[]> {
  const result: any = await db.execute(sql`
    UPDATE ops_alerts
       SET last_attempt_at = now()
     WHERE id IN (
       SELECT id FROM ops_alerts
        WHERE accepted_at IS NULL
          AND (last_attempt_at IS NULL
               OR last_attempt_at < now() - make_interval(secs => ${OPS_ALERT_LEASE_SECONDS}))
        ORDER BY last_attempt_at ASC NULLS FIRST, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, dedupe_key, subject, body
  `);
  const rows: any[] = result?.rows ?? result ?? [];
  return rows.map((r) => ({
    id: String(r.id),
    dedupeKey: String(r.dedupe_key),
    subject: String(r.subject),
    body: String(r.body),
  }));
}

export async function markOpsAlertAccepted(id: string): Promise<void> {
  await db
    .update(opsAlerts)
    .set({ acceptedAt: sql`now()`, lastError: null })
    .where(eq(opsAlerts.id, id));
}

/** The lease stamp stays: the row is retried once it expires. */
export async function markOpsAlertFailed(id: string, error: string): Promise<void> {
  await db
    .update(opsAlerts)
    .set({ lastError: error.slice(0, 1000) })
    .where(eq(opsAlerts.id, id));
}
