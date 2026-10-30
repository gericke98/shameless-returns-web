// Cancellation's half of submission ownership (S2 plan L2), and the two
// cancellation primitives moved out of the "use server" db/queries.ts — where
// every export was a public endpoint — into a plain server module.
//
// The submission row is the single serialization point between settlement and
// a customer's cancellation. Cancellation takes it with ONE conditional
// UPDATE, before its first external effect (the Amphora cancel), and only when
// settlement has admitted nothing. While cancellation holds it, settlement can
// never admit it; a crash mid-cancel leaves it held, and the recovery cron
// alerts on it after an hour.
//
// NOT "use server".
import { sql, type SQL } from "drizzle-orm";
import db, { transact } from "@/db/drizzle";
import { submissionForRow } from "@/lib/settlement/legacy";
import { SHOPIFY_API_VERSION } from "@/lib/settlement/shopify";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/**
 * A productsorder row is "held" when it belongs — by the Shopify return line
 * item it carries — to an accepted submission that cancellation does not hold.
 * Portal edits and resets refuse such rows. Settlement reads the submission,
 * never the rows, so this cannot redirect money; it keeps the portal honest.
 */
export const rowNotHeldBySettlement = (rowAlias: SQL) => sql`NOT EXISTS (
  SELECT 1 FROM submission_lines sl
    JOIN return_submissions s ON s.id = sl.submission_id
   WHERE sl.productsorder_id = ${rowAlias}.id
     AND sl.return_line_item_id IS NOT NULL
     AND sl.return_line_item_id = ${rowAlias}.return_line_item_id
     AND s.state = 'accepted'
     AND s.holder IS DISTINCT FROM 'cancellation')`;

/** Take the submission for cancellation. False if settlement got there first. */
export async function claimForCancellation(submissionId: string): Promise<boolean> {
  const rows = rowsOf(
    await db.execute(sql`
      UPDATE return_submissions
         SET holder = 'cancellation', holder_since = now()
       WHERE id = ${submissionId}
         AND state = 'accepted'
         AND holder IS NULL
         AND NOT EXISTS (SELECT 1 FROM settlement_operations o WHERE o.submission_id = ${submissionId})
      RETURNING id
    `)
  );
  return rows.length === 1;
}

export type CancellationClaim =
  | { ok: true; submissionIds: string[] }
  | { ok: false; reason: "already-settled" | "no-return" };

/**
 * Take every submission behind the return being cancelled — the accepted
 * submission each confirmed, unsettled row belongs to (a legacy one is
 * recorded first, D1). All or nothing: when settlement holds any of them, the
 * ones already taken are given back and the cancel is refused.
 */
export async function claimOrderForCancellation(
  rows: ReadonlyArray<{ id: number; confirmed?: boolean | null; refunded?: boolean | null; return_line_item_id?: string | null }>
): Promise<CancellationClaim> {
  const current = rows.filter((r) => r.confirmed === true && r.refunded !== true && r.return_line_item_id);
  if (current.length === 0) return { ok: false, reason: "no-return" };
  const ids = new Set<string>();
  for (const row of current) {
    const found = await submissionForRow(row.id);
    // A row nothing can record a submission for cannot be proven unsettled.
    if (!found.ok) return { ok: false, reason: "already-settled" };
    ids.add(found.submissionId);
  }
  const taken: string[] = [];
  for (const id of Array.from(ids)) {
    if (!(await claimForCancellation(id))) {
      for (const back of taken) await releaseCancellation(back);
      return { ok: false, reason: "already-settled" };
    }
    taken.push(id);
  }
  return { ok: true, submissionIds: taken };
}

/** Amphora refused, so nothing moved: give the submission back. */
export async function releaseCancellation(submissionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE return_submissions SET holder = NULL, holder_since = NULL
     WHERE id = ${submissionId} AND holder = 'cancellation' AND state = 'accepted'
  `);
}

/**
 * Put an order back to the state it was in before the customer submitted —
 * as statements, so the cancellation can run them in its final transaction.
 *
 * NOT `updateFinalOrder(revert)`, which refuses any row carrying a `return_id`
 * (the guard added after #310957). This is the deliberate counterpart: it runs
 * only after the Shopify return has actually been cancelled, so clearing the
 * id records reality rather than hiding it.
 *
 * `stripePaymentIntent` is cleared with the tracking: it belongs to the charge
 * for the return that no longer exists, and has just been refunded. The
 * self-booked lane's columns belong to that return as much as the tracking
 * (a surviving `returnSubmittedAt` swallows the next self-booked return; a
 * surviving null `trackingSubmittedAt` nudges a customer about a cancelled
 * one). `refunded` on the lines is deliberately kept: it is the permanent
 * record that we settled that garment. `changed` goes with the selection —
 * #311258 rendered a struck-through size next to nothing.
 *
 * Rows still held by a settlement (another accepted submission) are left
 * untouched.
 */
export function resetOrderReturnStatements(orderId: string): SQL[] {
  return [
    sql`
      UPDATE orders
         SET locator = NULL, carrier = NULL, carrier_url = NULL, return_status = NULL,
             stripe_payment_intent = NULL, return_method = NULL, return_submitted_at = NULL,
             tracking_submitted_at = NULL, tracking_nudge_stage = 0
       WHERE id = ${orderId}`,
    sql`
      UPDATE productsorder p
         SET confirmed = false, return_id = NULL, return_line_item_id = NULL, action = NULL,
             reason = NULL, notes = NULL, new_variant_id = NULL, new_variant_title = NULL,
             changed = false
       WHERE p.order_id = ${orderId}
         AND ${rowNotHeldBySettlement(sql`p`)}`,
  ];
}

/** Standalone reset, for callers outside a cancellation transaction. */
export async function resetOrderReturn(orderId: string): Promise<void> {
  await transact(resetOrderReturnStatements(orderId));
}

/**
 * The cancellation's last write, ONE transaction: the submissions it holds
 * become `cancelled`, then the order's rows are reset. A crash before this
 * leaves the submissions held, which recovery alerts on.
 */
export async function finishCancellation(orderId: string, submissionIds: readonly string[]): Promise<void> {
  await transact([
    sql`
      UPDATE return_submissions SET state = 'cancelled'
       WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(submissionIds)}::jsonb))::uuid)
         AND holder = 'cancellation' AND state = 'accepted'`,
    ...resetOrderReturnStatements(orderId),
  ]);
}

const RETURN_CANCEL = `
  mutation CancelReturn($id: ID!) {
    returnCancel(id: $id) {
      return { id status }
      userErrors { field message }
    }
  }`;

/**
 * Cancel a Shopify return. Reports failure rather than throwing: its only
 * caller has already cancelled the Amphora return and cannot undo that, so it
 * must carry on and alert a human instead of dying mid-chain.
 */
export async function cancelShopifyReturn(
  returnId: string
): Promise<{ success: boolean; errors?: unknown }> {
  try {
    const shop = process.env.NEXT_PUBLIC_SHOP_URL;
    const token = process.env.NEXT_PUBLIC_ACCESS_TOKEN;
    if (!shop || !token) throw new Error("Missing Shopify access token or shop URL");
    const response = await fetch(`${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: RETURN_CANCEL, variables: { id: returnId } }),
    });
    const data = await response.json();
    const userErrors = data?.data?.returnCancel?.userErrors ?? [];
    if (data.errors || userErrors.length > 0) {
      console.error("Error cancelling return:", data.errors || userErrors);
      return { success: false, errors: data.errors || userErrors };
    }
    return { success: true };
  } catch (error) {
    console.error("Fetch error cancelling return:", error);
    return { success: false, errors: error };
  }
}
