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

/** One submission a cancellation reverses, with the identities it reverses by. */
export type CancellationMember = {
  submissionId: string;
  /** The Shopify return this submission's lines are on — exactly one. */
  returnId: string;
  /** What to refund in Stripe, and by which identity (key `cancel:<submissionId>`). */
  payment:
    | { kind: "none" }
    /** The submission's own PaymentIntent, stored when its payment was verified. */
    | { kind: "intent"; paymentIntent: string }
    /** A legacy submission (recorded at this cancellation, D1) has no payment
     *  of its own on record: the order's single portal payment is resolved
     *  from the order — allowed only when it is the ONE submission cancelled. */
    | { kind: "order-payment" };
};

export type CancellationClaim =
  | { ok: true; members: CancellationMember[] }
  | { ok: false; reason: "already-settled" | "no-return" }
  /** Membership or a payment could not be established: refused BEFORE any
   *  external effect, for a human (finding 3). */
  | { ok: false; reason: "needs-support"; detail: string };

type CancellableRow = {
  id: number;
  confirmed?: boolean | null;
  refunded?: boolean | null;
  return_line_item_id?: string | null;
};

/** Each submission's own return(s) and payment, from the database. */
async function membersOf(submissionIds: readonly string[]): Promise<
  Array<{ id: string; provenance: string; chargeCents: number; paymentIntent: string | null; returnIds: string[] }>
> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT s.id, s.provenance, s.stripe_charge_cents, s.stripe_payment_intent,
             COALESCE(array_agg(DISTINCT p.return_id) FILTER (WHERE p.return_id IS NOT NULL), '{}') AS return_ids
        FROM return_submissions s
        LEFT JOIN submission_lines sl ON sl.submission_id = s.id
        LEFT JOIN productsorder p
          ON p.id = sl.productsorder_id AND p.return_line_item_id = sl.return_line_item_id
       WHERE s.id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(submissionIds)}::jsonb))::uuid)
       GROUP BY s.id
    `)
  );
  return rows.map((r) => ({
    id: String(r.id),
    provenance: String(r.provenance),
    chargeCents: Number(r.stripe_charge_cents),
    paymentIntent: r.stripe_payment_intent ? String(r.stripe_payment_intent) : null,
    returnIds: (Array.isArray(r.return_ids) ? r.return_ids : []).map(String),
  }));
}

/**
 * Establish the COMPLETE set of submissions behind the return being cancelled,
 * with each one's own Shopify return and payment, then take them all. Every
 * confirmed, unsettled row must belong to a submission (a legacy one is
 * recorded first, D1); a row that cannot be mapped refuses the whole cancel
 * rather than being left out of it. All or nothing on the claim too: when
 * settlement holds any of them, the ones already taken are given back.
 * Nothing external has happened when this refuses.
 */
export async function claimOrderForCancellation(rows: ReadonlyArray<CancellableRow>): Promise<CancellationClaim> {
  const current = rows.filter((r) => r.confirmed === true && r.refunded !== true);
  if (current.length === 0) return { ok: false, reason: "no-return" };
  const unmapped = current.filter((r) => !r.return_line_item_id);
  if (unmapped.length > 0) {
    return {
      ok: false,
      reason: "needs-support",
      detail: `confirmed row(s) ${unmapped.map((r) => r.id).join(", ")} carry no Shopify return line item`,
    };
  }
  const ids = new Set<string>();
  for (const row of current) {
    const found = await submissionForRow(row.id);
    if (!found.ok) {
      return { ok: false, reason: "needs-support", detail: `row ${row.id} belongs to no submission (${found.held})` };
    }
    ids.add(found.submissionId);
  }

  const loaded = await membersOf(Array.from(ids));
  const members: CancellationMember[] = [];
  for (const m of loaded) {
    if (m.returnIds.length !== 1) {
      return {
        ok: false,
        reason: "needs-support",
        detail: `submission ${m.id} is on ${m.returnIds.length} Shopify returns`,
      };
    }
    let payment: CancellationMember["payment"];
    if (m.provenance === "legacy") {
      if (ids.size !== 1) {
        return {
          ok: false,
          reason: "needs-support",
          detail: `legacy submission ${m.id} has no payment of its own and is cancelled with ${ids.size - 1} other(s)`,
        };
      }
      payment = { kind: "order-payment" };
    } else if (m.chargeCents > 0) {
      if (!m.paymentIntent) {
        return { ok: false, reason: "needs-support", detail: `submission ${m.id} was paid but stores no PaymentIntent` };
      }
      payment = { kind: "intent", paymentIntent: m.paymentIntent };
    } else {
      payment = { kind: "none" };
    }
    members.push({ submissionId: m.id, returnId: m.returnIds[0], payment });
  }
  if (members.length !== ids.size) {
    return { ok: false, reason: "needs-support", detail: "a submission could not be loaded" };
  }

  const taken: string[] = [];
  for (const m of members) {
    if (!(await claimForCancellation(m.submissionId))) {
      for (const back of taken) await releaseCancellation(back);
      return { ok: false, reason: "already-settled" };
    }
    taken.push(m.submissionId);
  }
  return { ok: true, members };
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
