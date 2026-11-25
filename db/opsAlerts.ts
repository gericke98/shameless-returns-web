// The database half of the ops-alert outbox. Delivery policy lives in
// actions/opsAlertOutbox.ts; this file only inserts, claims and marks rows.
//
// NOT a "use server" module, for the same reason as db/lookupAttempts.ts.
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import db, { opsAlertsWriter as alerts } from "./drizzle";
import { opsAlerts } from "./schema";

// ops_alerts holds no customer data: it is written through its own
// table-bound writer, which can reach no other table (F1 spec §11).

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
  const rows = await alerts
    .insert()
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
  // UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING …: the
  // subquery is only built here, and runs inside the writer's one UPDATE.
  const claimable = db
    .select({ id: opsAlerts.id })
    .from(opsAlerts)
    .where(
      and(
        isNull(opsAlerts.acceptedAt),
        or(
          isNull(opsAlerts.lastAttemptAt),
          lt(opsAlerts.lastAttemptAt, sql`now() - make_interval(secs => ${OPS_ALERT_LEASE_SECONDS})`)
        )
      )
    )
    .orderBy(sql`${opsAlerts.lastAttemptAt} ASC NULLS FIRST`, asc(opsAlerts.createdAt))
    // A placeholder, bound at execute: drizzle 0.30 drops LIMIT for a falsy
    // number, and a limit of 0 must claim nothing, not everything.
    .limit(sql.placeholder("limit"))
    .for("update", { skipLocked: true });
  const rows = await alerts
    .update()
    .set({ lastAttemptAt: sql`now()` })
    .where(inArray(opsAlerts.id, claimable))
    .returning({ id: opsAlerts.id, dedupeKey: opsAlerts.dedupeKey, subject: opsAlerts.subject, body: opsAlerts.body })
    .execute({ limit });
  return rows.map((r) => ({
    id: String(r.id),
    dedupeKey: String(r.dedupeKey),
    subject: String(r.subject),
    body: String(r.body),
  }));
}

export async function markOpsAlertAccepted(id: string): Promise<void> {
  await alerts
    .update()
    .set({ acceptedAt: sql`now()`, lastError: null })
    .where(eq(opsAlerts.id, id));
}

/** The lease stamp stays: the row is retried once it expires. */
export async function markOpsAlertFailed(id: string, error: string): Promise<void> {
  await alerts
    .update()
    .set({ lastError: error.slice(0, 1000) })
    .where(eq(opsAlerts.id, id));
}
