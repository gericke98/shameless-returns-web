import "server-only";
// The submission capability (F1 spec §1, blocker 15, finding 7).
//
// A submission id alone proves nothing: it is a uuid that travelled through a
// browser (Stripe metadata) or a cron's query. Every function here takes a
// `VerifiedSubmission` — a server-minted id BOUND to the verified order it
// belongs to — and every statement carries `order_id = sub.orderId` as well as
// the submission id, so a submission of one order can never move another
// order's rows.
//
// A `VerifiedSubmission` comes from exactly two places, both here:
//   - `proposeSubmission`, for the row it just inserted for that order;
//   - `submissionOf(orderId, id)`, a SELECT that matched both.
//
// Every transition is ONE conditional statement (`UPDATE … WHERE state = …
// RETURNING`), so it is atomic on neon-http, which has no interactive
// transactions, and the row's state, not a prior read, decides who wins.
import { and, eq, sql, type SQL } from "drizzle-orm";
import db, { readQuery, writeDb } from "@/db/drizzle";
import { orders, returnSubmissions, submissionLines } from "@/db/schema";
import type { Agreement } from "@/lib/agreement";
import type { PaidOutcome, PaymentEvidence, SubmissionLineInput } from "@/db/submissions";
import { boundSubmission, type VerifiedOrderId, type VerifiedSubmission } from "./identity";

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

const isUniqueViolation = (error: any) => (error?.code ?? error?.cause?.code) === "23505";

/**
 * Record a new agreement for the order and supersede any earlier one still
 * awaiting payment, in one statement.
 *
 * `ins` reads `sup`, so the supersede runs to completion before the insert —
 * that ordering is what lets the new row pass the one-awaiting-per-order
 * index. Two proposals racing for the same order cannot both pass it: the
 * loser gets a unique violation, reported as `conflict`.
 */
export async function proposeSubmission(
  orderId: VerifiedOrderId,
  input: { returnMethod: string; agreement: Agreement; lines: readonly SubmissionLineInput[] }
): Promise<{ ok: true; submission: VerifiedSubmission } | { ok: false; conflict: true }> {
  const a = input.agreement;
  const lines = lineRecords(input.agreement, input.lines);

  try {
    const result = await writeDb(orderId).execute(sql`
      WITH sup AS (
        UPDATE return_submissions SET state = 'superseded'
         WHERE order_id = ${orderId} AND state = 'awaiting_payment'
        RETURNING 1
      ),
      ins AS (
        INSERT INTO return_submissions (
          order_id, tender, return_method, return_leg_cents, outbound_leg_cents,
          charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
          stripe_charge_cents, waived_cents, owed_cents, residual_cents)
        SELECT ${orderId}, ${a.tender}, ${input.returnMethod}, ${a.returnLegCents},
               ${a.outboundLegCents}, ${a.chargedFeeCents}, ${a.returnedValueCents},
               ${a.replacementValueCents}, ${a.netCents}, ${a.stripeChargeCents},
               ${a.waivedCents}, ${a.owedCents}, ${a.residualCents}
          FROM (SELECT count(*) FROM sup) AS superseded
        RETURNING id
      ),
      ${insertLines(lines)}
      SELECT id, (SELECT count(*) FROM lines)::int AS line_count FROM ins
    `);
    return { ok: true, submission: boundSubmission(orderId, insertedId(result, lines.length)) };
  } catch (error: any) {
    if (isUniqueViolation(error)) return { ok: false, conflict: true };
    throw error;
  }
}

function insertedId(result: unknown, expected: number): string {
  const row = rowsOf(result)[0];
  if (!row || Number(row.line_count) !== expected) {
    throw new Error(`submission insert wrote ${row?.line_count ?? 0} of ${expected} lines`);
  }
  return String(row.id);
}

/** The `lines` CTE: inserts every line of the submission `ins` returned. */
function insertLines(lines: ReturnType<typeof lineRecords>) {
  return sql`lines AS (
        INSERT INTO submission_lines (
          submission_id, productsorder_id, shopify_line_item_id, fulfillment_line_item_id,
          quantity, action, new_variant_id, reason, notes, returned_cents,
          replacement_cents, pay_cents, stripe_funded_cents)
        SELECT ins.id, l.productsorder_id, l.shopify_line_item_id, l.fulfillment_line_item_id,
               l.quantity, l.action, l.new_variant_id, l.reason, l.notes, l.returned_cents,
               l.replacement_cents, l.pay_cents, l.stripe_funded_cents
          FROM ins, jsonb_to_recordset(${JSON.stringify(lines)}::jsonb) AS l(
            productsorder_id integer, shopify_line_item_id text,
            fulfillment_line_item_id text, quantity integer, action text,
            new_variant_id text, reason text, notes text, returned_cents integer,
            replacement_cents integer, pay_cents integer, stripe_funded_cents integer)
        RETURNING 1
      )`;
}

function lineRecords(a: Agreement, meta: readonly SubmissionLineInput[]) {
  const byId = new Map(meta.map((l) => [l.productsorderId, l]));
  return a.lines.map((line) => {
    const meta = byId.get(line.id);
    if (!meta) throw new Error(`submission: no metadata for line ${line.id}`);
    return {
      productsorder_id: line.id,
      shopify_line_item_id: meta.shopifyLineItemId,
      fulfillment_line_item_id: meta.fulfillmentLineItemId,
      quantity: line.quantity,
      action: line.action,
      new_variant_id: line.action === "CAMBIO" ? meta.newVariantId : null,
      reason: meta.reason,
      notes: meta.notes,
      returned_cents: line.returnedCents,
      replacement_cents: line.replacementCents,
      pay_cents: line.payCents,
      stripe_funded_cents: line.stripeFundedCents,
    };
  });
}

/**
 * The submission `submissionId` OF this order, or null when the pair does not
 * match. This is how a submission id that travelled outside the server (Stripe
 * metadata, a cron's selection) becomes a capability: only together with an
 * order the caller already holds a credential for.
 */
export async function submissionOf(
  orderId: VerifiedOrderId,
  submissionId: string
): Promise<VerifiedSubmission | null> {
  // Not a uuid: no such row (and never a SQL cast error on garbage).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId)) return null;
  const [row] = await db
    .select({ id: returnSubmissions.id })
    .from(returnSubmissions)
    .where(and(eq(returnSubmissions.id, submissionId), eq(returnSubmissions.orderId, orderId)));
  return row ? boundSubmission(orderId, String(row.id)) : null;
}

/** The submission row and its agreed lines. Null if it is gone. */
export async function loadSubmission(sub: VerifiedSubmission) {
  const [submission] = await db
    .select()
    .from(returnSubmissions)
    .where(and(eq(returnSubmissions.id, sub.id), eq(returnSubmissions.orderId, sub.orderId)));
  if (!submission) return null;
  const lines = await db.select().from(submissionLines).where(eq(submissionLines.submissionId, sub.id));
  return { submission, lines };
}

/** Bind the Stripe session to the submission. False if it is no longer awaiting. */
export async function attachStripeSession(sub: VerifiedSubmission, sessionId: string): Promise<boolean> {
  const result = await writeDb(sub).execute(sql`
    UPDATE return_submissions SET stripe_session_id = ${sessionId}
     WHERE id = ${sub.id} AND order_id = ${sub.orderId}
       AND state = 'awaiting_payment' AND stripe_session_id IS NULL
    RETURNING id
  `);
  return rowsOf(result).length === 1;
}

/** Accept a submission that owes Stripe nothing. False if it was not awaiting. */
export async function acceptFreeSubmission(sub: VerifiedSubmission): Promise<boolean> {
  const result = await writeDb(sub).execute(sql`
    UPDATE return_submissions SET state = 'accepted', accepted_at = now()
     WHERE id = ${sub.id} AND order_id = ${sub.orderId}
       AND state = 'awaiting_payment' AND stripe_charge_cents = 0
    RETURNING id
  `);
  return rowsOf(result).length === 1;
}

/**
 * Accept a paid submission — only when the payment is exactly the one it
 * asked for: this session, this amount, EUR, paid. Everything is in the
 * WHERE clause, so the check and the transition are one atomic step; a
 * redelivered webhook finds the row already accepted and changes nothing.
 */
export async function acceptPaidSubmission(
  sub: VerifiedSubmission,
  evidence: PaymentEvidence
): Promise<PaidOutcome> {
  const result = await writeDb(sub).execute(sql`
    UPDATE return_submissions
       SET state = 'accepted', accepted_at = now(),
           stripe_payment_intent = ${evidence.paymentIntent}
     WHERE id = ${sub.id}
       AND order_id = ${sub.orderId}
       AND state = 'awaiting_payment'
       AND stripe_session_id = ${evidence.sessionId}
       AND stripe_charge_cents = ${evidence.amountTotal ?? -1}
       AND ${String(evidence.currency ?? "").toLowerCase()} = 'eur'
       AND ${evidence.paymentStatus ?? ""} = 'paid'
    RETURNING id
  `);
  if (rowsOf(result).length === 1) return { kind: "accepted" };

  const [row] = await db
    .select()
    .from(returnSubmissions)
    .where(and(eq(returnSubmissions.id, sub.id), eq(returnSubmissions.orderId, sub.orderId)));
  if (!row) return { kind: "unknown-submission" };
  if (row.state === "accepted" && row.stripeSessionId === evidence.sessionId) {
    return { kind: "duplicate" };
  }
  if (row.state === "superseded" || row.state === "abandoned") {
    return { kind: "superseded", state: row.state };
  }
  return {
    kind: "mismatch",
    detail:
      `state=${row.state} session=${row.stripeSessionId ?? "(none)"}/${evidence.sessionId} ` +
      `amount=${row.stripeChargeCents}/${evidence.amountTotal} ` +
      `currency=${evidence.currency} status=${evidence.paymentStatus}`,
  };
}

/**
 * Write the Shopify return onto the submission's lines AND onto the
 * productsorder rows, by row id, in one statement. `action` and
 * `new_variant_id` are copied from the submission, so the rows end up saying
 * what was paid for even if they were edited after checkout.
 *
 * Both halves are scoped to the submission's order: its lines only while the
 * submission row is this order's, and a productsorder row only when it is this
 * order's own (`p.order_id`). A line naming another order's row changes
 * nothing there.
 */
export async function recordConfirmation(
  sub: VerifiedSubmission,
  input: {
    returnId: string;
    transactionId: string | null;
    transactionAmount: string | null;
    credit: boolean;
    lines: ReadonlyArray<{
      productsorderId: number;
      fulfillmentLineItemId: string;
      returnLineItemId: string;
    }>;
  }
): Promise<number[]> {
  const values = input.lines.map((l) => ({
    productsorder_id: l.productsorderId,
    fulfillment_line_item_id: l.fulfillmentLineItemId,
    return_line_item_id: l.returnLineItemId,
  }));
  const result = await writeDb(sub).execute(sql`
    WITH v AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(
        productsorder_id integer, fulfillment_line_item_id text, return_line_item_id text)
    ),
    sl AS (
      UPDATE submission_lines s
         SET fulfillment_line_item_id = v.fulfillment_line_item_id,
             return_line_item_id = v.return_line_item_id
        FROM v
       WHERE s.submission_id = ${sub.id}
         AND EXISTS (SELECT 1 FROM return_submissions r
                      WHERE r.id = ${sub.id} AND r.order_id = ${sub.orderId})
         AND s.productsorder_id = v.productsorder_id
      RETURNING s.productsorder_id, s.action, s.new_variant_id, s.return_line_item_id
    )
    UPDATE productsorder p
       SET confirmed = true,
           return_id = ${input.returnId},
           return_line_item_id = sl.return_line_item_id,
           transaction_id = ${input.transactionId},
           transaction_amount = ${input.transactionAmount},
           action = sl.action,
           new_variant_id = sl.new_variant_id,
           credit = ${input.credit}
      FROM sl
     WHERE p.id = sl.productsorder_id
       AND p.order_id = ${sub.orderId}
    RETURNING p.id
  `);
  return rowsOf(result).map((r) => Number(r.id));
}

/**
 * Why a cancellation did or did not take a submission, decided under the
 * submission's row lock (Codex review of F1, finding 3):
 * - `claimed`: this cancellation holds it now.
 * - `in-transit`: a self-booked return whose tracking was claimed first; the
 *   parcel is presumed in the network (cancelEligibility's own rule).
 * - `cancelled`: another cancellation holds it, or has already finished it.
 * - `held`: a settlement hold blocks it (open, or settled by hand — FX §#7):
 *   an operator decides it, never the customer.
 * - `settled`: settlement holds it, has planned operations for it, or it is
 *   no longer an accepted submission.
 */
export type CancellationClaimOutcome = "claimed" | "in-transit" | "cancelled" | "held" | "settled";

/** Take the submission for cancellation, or say exactly why not. */
export async function claimForCancellation(sub: VerifiedSubmission): Promise<CancellationClaimOutcome> {
  // ONE transaction (F1 spec §10). (1) takes the submission's row lock, the
  // same lock `claimTracking` takes. (2) runs on a fresh READ COMMITTED
  // snapshot taken after that lock, so it sees a tracking claim that committed
  // while (1) waited, and refuses: a self-booked return with tracking is
  // `in-transit` (cancelEligibility), here enforced where the two serialize.
  // (3) reads, still under the lock, why (2) did or did not take it, so the
  // answer is the state the decision was made on, not a later read.
  const [, claimed, why] = await writeDb(sub).transact([
    sql`
      SELECT id FROM return_submissions
       WHERE id = ${sub.id} AND order_id = ${sub.orderId}
       FOR UPDATE`,
    sql`
      UPDATE return_submissions
         SET holder = 'cancellation', holder_since = now()
       WHERE id = ${sub.id}
         AND order_id = ${sub.orderId}
         AND state = 'accepted'
         AND holder IS NULL
         AND NOT EXISTS (SELECT 1 FROM settlement_operations o WHERE o.submission_id = ${sub.id})
         AND NOT EXISTS (SELECT 1 FROM settlement_holds h
                          WHERE h.submission_id = ${sub.id}
                            AND (h.resolved_at IS NULL OR h.resolution = 'manual'))
         AND NOT EXISTS (SELECT 1 FROM orders o
                          WHERE o.id = ${sub.orderId}
                            AND o.return_method = 'SELF'
                            AND o.locator IS NOT NULL)
      RETURNING id`,
    sql`
      SELECT s.state, s.holder,
             EXISTS (SELECT 1 FROM orders o
                      WHERE o.id = s.order_id AND o.return_method = 'SELF'
                        AND o.locator IS NOT NULL) AS in_transit,
             EXISTS (SELECT 1 FROM settlement_holds h
                      WHERE h.submission_id = s.id
                        AND (h.resolved_at IS NULL OR h.resolution = 'manual')) AS held
        FROM return_submissions s
       WHERE s.id = ${sub.id} AND s.order_id = ${sub.orderId}`,
  ]);
  if ((claimed ?? []).length === 1) return "claimed";
  const row = (why ?? [])[0];
  if (!row) throw new Error(`submission ${sub.id} of order ${sub.orderId} vanished under its own lock`);
  if (row.in_transit === true) return "in-transit";
  if (row.state === "cancelled" || row.holder === "cancellation") return "cancelled";
  if (row.held === true) return "held";
  return "settled";
}

/** Amphora refused, so nothing moved: give the submission back. */
export async function releaseCancellation(sub: VerifiedSubmission): Promise<void> {
  await writeDb(sub).execute(sql`
    UPDATE return_submissions SET holder = NULL, holder_since = NULL
     WHERE id = ${sub.id} AND order_id = ${sub.orderId}
       AND holder = 'cancellation' AND state = 'accepted'
  `);
}

/**
 * Put an order back to the state it was in before the customer submitted —
 * as statements, so the cancellation can run them in its final transaction.
 *
 * NOT `revertFinalOrder`, which refuses any row carrying a `return_id` (the
 * guard added after #310957). This is the deliberate counterpart: it runs
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
function resetOrderReturnStatements(orderId: VerifiedOrderId) {
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

/**
 * The cancellation's last write, ONE transaction: the submissions it holds
 * become `cancelled`, then the order's rows are reset. A crash before this
 * leaves the submissions held, which recovery alerts on.
 */
export async function finishCancellation(
  orderId: VerifiedOrderId,
  subs: readonly VerifiedSubmission[]
): Promise<void> {
  const foreign = subs.find((s) => s.orderId !== orderId);
  if (foreign) throw new Error(`finishCancellation: submission ${foreign.id} is not order ${orderId}'s`);
  await writeDb(orderId).transact([
    sql`
      UPDATE return_submissions SET state = 'cancelled'
       WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(subs.map((s) => s.id))}::jsonb))::uuid)
         AND order_id = ${orderId}
         AND holder = 'cancellation' AND state = 'accepted'`,
    ...resetOrderReturnStatements(orderId),
  ]);
}

/**
 * The order's ONE self-booked submission that may still take tracking
 * (F1 spec §4, decided A): `return_method = 'SELF'`, `accepted`, not held by
 * cancellation, every line confirmed (it carries its Shopify return line
 * item), and the order booked (`return_submitted_at`). Identified, never
 * inferred from `orders.return_method` — that column is written before
 * checkout. Null when there is none (or, defensively, more than one).
 */
export async function activeSelfSubmission(orderId: VerifiedOrderId): Promise<VerifiedSubmission | null> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT s.id
        FROM return_submissions s
        JOIN orders o ON o.id = s.order_id
       WHERE s.order_id = ${orderId}
         AND s.return_method = 'SELF'
         AND s.state = 'accepted'
         AND s.holder IS NULL
         AND o.return_submitted_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM submission_lines sl WHERE sl.submission_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM submission_lines sl
                          WHERE sl.submission_id = s.id AND sl.return_line_item_id IS NULL)
    `)
  );
  return rows.length === 1 ? boundSubmission(orderId, String(rows[0].id)) : null;
}

/** What the tracking claim writes onto the order: the existing write-once columns. */
export type TrackingWrite = {
  locator: string;
  carrier: string;
  carrierUrl: string;
  verifiedBy: string | null;
};

/**
 * Claim the order's tracking slot for this self-booked submission, in ONE
 * transaction (F1 spec §4):
 *
 *   1. `SELECT … FOR UPDATE` the submission while it is still accepted and
 *      unheld. `claimForCancellation`'s UPDATE on the same row waits for this
 *      lock, so a cancellation either commits first (and step 2 sees the
 *      holder) or runs after this claim commits.
 *   2. The existing write-once `UPDATE orders … WHERE locator IS NULL`, which
 *      also re-checks the submission under the lock: READ COMMITTED gives
 *      each statement a fresh snapshot, so it sees whatever a cancellation
 *      committed before step 1 took the lock.
 *
 * `tracking_submission_id` stays a fresh id per tracking ATTEMPT (what ops
 * Confirm/Reject compares), not the return submission's id. True only when
 * this call wrote the slot. The Amphora pin happens after, outside the lock.
 */
export async function claimTracking(sub: VerifiedSubmission, write: TrackingWrite): Promise<boolean> {
  const stillActive = sql`EXISTS (
    SELECT 1 FROM return_submissions s
     WHERE s.id = ${sub.id} AND s.order_id = ${sub.orderId}
       AND s.state = 'accepted' AND s.holder IS NULL)`;
  const [, written] = await writeDb(sub).transact([
    sql`
      SELECT id FROM return_submissions
       WHERE id = ${sub.id} AND order_id = ${sub.orderId}
         AND state = 'accepted' AND holder IS NULL
       FOR UPDATE`,
    sql`
      UPDATE ${orders}
         SET locator = ${write.locator},
             carrier = ${write.carrier},
             carrier_url = ${write.carrierUrl},
             tracking_submitted_at = now(),
             tracking_verified_at = ${write.verifiedBy ? sql`now()` : null},
             tracking_verified_by = ${write.verifiedBy},
             tracking_submission_id = ${crypto.randomUUID()}
       WHERE id = ${sub.orderId}
         AND locator IS NULL
         AND ${stillActive}
      RETURNING id`,
  ]);
  return (written ?? []).length === 1;
}
