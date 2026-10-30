// The database half of short-receipt detection. Decisions live in
// lib/receiptShortfall.ts and actions/receiptShortfallSweep.ts; this file only
// records, resolves and advances rows.
//
// NOT a "use server" module, for the same reason as db/lookupAttempts.ts.
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import db from "./drizzle";
import { receiptShortfalls } from "./schema";

export type ShortfallRow = typeof receiptShortfalls.$inferSelect;

/** The ops_alerts dedupe key for one stage of one opening of a case. Must
 *  match `STAGE_KEY_SQL` below character for character. */
export function shortfallAlertKey(
  row: Pick<ShortfallRow, "id" | "reopenCount">,
  stage: 1 | 2
): string {
  return `shortfall:${row.id}:open${row.reopenCount}:stage${stage}`;
}

const STAGE_KEY_SQL = (stage: 1 | 2) =>
  sql.raw(
    `'shortfall:' || receipt_shortfalls.id || ':open' || receipt_shortfalls.reopen_count || ':stage${stage}'`
  );

/**
 * Record a shortfall seen now. One statement, so concurrent runs cannot
 * double-open: a new (return, SKU) inserts; an open one bumps `last_seen_at`
 * and the counts; a RESOLVED one reopens — stage 0, anchor cleared,
 * `reopen_count` + 1 — so a fresh alert and a fresh 7-day clock start.
 */
export async function recordShortfall(shortfall: {
  amphoraReturnId: string;
  orderId: string;
  sku: string;
  shopifyReturnIds: string[];
  declaredQty: number;
  receivedQty: number;
}): Promise<void> {
  const t = receiptShortfalls;
  const wasResolved = sql`${t.resolvedAt} IS NOT NULL`;
  await db
    .insert(t)
    .values(shortfall)
    .onConflictDoUpdate({
      target: [t.amphoraReturnId, t.sku],
      set: {
        orderId: sql`excluded.order_id`,
        shopifyReturnIds: sql`excluded.shopify_return_ids`,
        declaredQty: sql`excluded.declared_qty`,
        receivedQty: sql`excluded.received_qty`,
        lastSeenAt: sql`now()`,
        reopenCount: sql`CASE WHEN ${wasResolved} THEN ${t.reopenCount} + 1 ELSE ${t.reopenCount} END`,
        alertStage: sql`CASE WHEN ${wasResolved} THEN 0 ELSE ${t.alertStage} END`,
        firstAlertAcceptedAt: sql`CASE WHEN ${wasResolved} THEN NULL ELSE ${t.firstAlertAcceptedAt} END`,
        resolvedAt: sql`NULL`,
      },
    });
}

/**
 * Resolve the open rows of one Amphora return, except the SKUs still short.
 * Called only after a positive observation of that return's count.
 */
export async function resolveShortfallsForReturn(
  amphoraReturnId: string,
  stillShortSkus: string[]
): Promise<number> {
  const t = receiptShortfalls;
  const rows = await db
    .update(t)
    .set({ resolvedAt: sql`now()` })
    .where(
      and(
        eq(t.amphoraReturnId, amphoraReturnId),
        isNull(t.resolvedAt),
        stillShortSkus.length ? notInArray(t.sku, stillShortSkus) : undefined
      )
    )
    .returning({ id: t.id });
  return rows.length;
}

/** Resolve every open row of an order: its lines are all settled, or every
 *  Shopify return involved is closed. */
export async function resolveShortfallsForOrder(orderId: string): Promise<number> {
  const t = receiptShortfalls;
  const rows = await db
    .update(t)
    .set({ resolvedAt: sql`now()` })
    .where(and(eq(t.orderId, orderId), isNull(t.resolvedAt)))
    .returning({ id: t.id });
  return rows.length;
}

export async function listOpenShortfalls(): Promise<ShortfallRow[]> {
  return db.select().from(receiptShortfalls).where(isNull(receiptShortfalls.resolvedAt));
}

/**
 * Advance open rows whose alert for the current stage Postmark has ACCEPTED,
 * reading the outbox row by its explicit dedupe key. The stage-1 anchor is the
 * outbox row's own `accepted_at`, written once (only while it is NULL), so a
 * failed or retried attempt can never move the 7-day clock.
 */
export async function advanceShortfallStages(): Promise<void> {
  await db.execute(sql`
    UPDATE receipt_shortfalls
       SET alert_stage = 1, first_alert_accepted_at = ops_alerts.accepted_at
      FROM ops_alerts
     WHERE ops_alerts.dedupe_key = ${STAGE_KEY_SQL(1)}
       AND ops_alerts.accepted_at IS NOT NULL
       AND receipt_shortfalls.alert_stage = 0
       AND receipt_shortfalls.first_alert_accepted_at IS NULL
       AND receipt_shortfalls.resolved_at IS NULL
  `);
  await db.execute(sql`
    UPDATE receipt_shortfalls
       SET alert_stage = 2
      FROM ops_alerts
     WHERE ops_alerts.dedupe_key = ${STAGE_KEY_SQL(2)}
       AND ops_alerts.accepted_at IS NOT NULL
       AND receipt_shortfalls.alert_stage = 1
       AND receipt_shortfalls.resolved_at IS NULL
  `);
}
