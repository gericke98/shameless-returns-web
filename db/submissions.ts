// The database half of the submission agreement (drizzle/0006_return_submissions.sql).
//
// Every transition is ONE conditional statement — `UPDATE … WHERE state = …
// RETURNING` — so it is atomic on neon-http, which has no interactive
// transactions, and the row's state, not a prior read, decides who wins.
//
// NOT a "use server" module, for the same reason as db/opsAlerts.ts: nothing
// here may be callable from a browser.
import { eq, sql } from "drizzle-orm";
import db from "./drizzle";
import { returnSubmissions, submissionLines } from "./schema";
import type { Agreement } from "@/lib/agreement";

export type SubmissionLineInput = {
  productsorderId: number;
  shopifyLineItemId: string;
  newVariantId: string | null;
  reason: string | null;
  notes: string | null;
};

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/**
 * Record a new agreement for `orderId` and supersede any earlier one still
 * awaiting payment, in one statement.
 *
 * `ins` reads `sup`, so the supersede runs to completion before the insert —
 * that ordering is what lets the new row pass the one-awaiting-per-order
 * index. Two proposals racing for the same order cannot both pass it: the
 * loser gets a unique violation, reported as `conflict`.
 */
export async function proposeSubmission(input: {
  orderId: string;
  returnMethod: string;
  agreement: Agreement;
  lines: readonly SubmissionLineInput[];
}): Promise<{ ok: true; id: string } | { ok: false; conflict: true }> {
  const a = input.agreement;
  const byId = new Map(input.lines.map((l) => [l.productsorderId, l]));
  const lines = a.lines.map((line) => {
    const meta = byId.get(line.id);
    if (!meta) throw new Error(`proposeSubmission: no metadata for line ${line.id}`);
    return {
      productsorder_id: line.id,
      shopify_line_item_id: meta.shopifyLineItemId,
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

  try {
    const result = await db.execute(sql`
      WITH sup AS (
        UPDATE return_submissions SET state = 'superseded'
         WHERE order_id = ${input.orderId} AND state = 'awaiting_payment'
        RETURNING 1
      ),
      ins AS (
        INSERT INTO return_submissions (
          order_id, tender, return_method, return_leg_cents, outbound_leg_cents,
          charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
          stripe_charge_cents, waived_cents, owed_cents, residual_cents)
        SELECT ${input.orderId}, ${a.tender}, ${input.returnMethod}, ${a.returnLegCents},
               ${a.outboundLegCents}, ${a.chargedFeeCents}, ${a.returnedValueCents},
               ${a.replacementValueCents}, ${a.netCents}, ${a.stripeChargeCents},
               ${a.waivedCents}, ${a.owedCents}, ${a.residualCents}
          FROM (SELECT count(*) FROM sup) AS superseded
        RETURNING id
      ),
      lines AS (
        INSERT INTO submission_lines (
          submission_id, productsorder_id, shopify_line_item_id, quantity, action,
          new_variant_id, reason, notes, returned_cents, replacement_cents,
          pay_cents, stripe_funded_cents)
        SELECT ins.id, l.productsorder_id, l.shopify_line_item_id, l.quantity, l.action,
               l.new_variant_id, l.reason, l.notes, l.returned_cents, l.replacement_cents,
               l.pay_cents, l.stripe_funded_cents
          FROM ins, jsonb_to_recordset(${JSON.stringify(lines)}::jsonb) AS l(
            productsorder_id integer, shopify_line_item_id text, quantity integer,
            action text, new_variant_id text, reason text, notes text,
            returned_cents integer, replacement_cents integer, pay_cents integer,
            stripe_funded_cents integer)
        RETURNING 1
      )
      SELECT id, (SELECT count(*) FROM lines)::int AS line_count FROM ins
    `);
    const row = rowsOf(result)[0];
    if (!row || Number(row.line_count) !== lines.length) {
      throw new Error(`proposeSubmission: wrote ${row?.line_count ?? 0} of ${lines.length} lines`);
    }
    return { ok: true, id: String(row.id) };
  } catch (error: any) {
    const code = error?.code ?? error?.cause?.code;
    if (code === "23505") return { ok: false, conflict: true };
    throw error;
  }
}

/** Bind the Stripe session to the submission. False if it is no longer awaiting. */
export async function attachStripeSession(id: string, sessionId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE return_submissions SET stripe_session_id = ${sessionId}
     WHERE id = ${id} AND state = 'awaiting_payment' AND stripe_session_id IS NULL
    RETURNING id
  `);
  return rowsOf(result).length === 1;
}

/** Accept a submission that owes Stripe nothing. False if it was not awaiting. */
export async function acceptFreeSubmission(id: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE return_submissions SET state = 'accepted', accepted_at = now()
     WHERE id = ${id} AND state = 'awaiting_payment' AND stripe_charge_cents = 0
    RETURNING id
  `);
  return rowsOf(result).length === 1;
}

export type PaymentEvidence = {
  sessionId: string;
  amountTotal: number | null;
  currency: string | null;
  paymentStatus: string | null;
  paymentIntent: string | null;
};

export type PaidOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "superseded"; state: string }
  | { kind: "mismatch"; detail: string }
  | { kind: "unknown-submission" };

/**
 * Accept a paid submission — only when the payment is exactly the one it
 * asked for: this session, this amount, EUR, paid. Everything is in the
 * WHERE clause, so the check and the transition are one atomic step; a
 * redelivered webhook finds the row already accepted and changes nothing.
 */
export async function acceptPaidSubmission(
  id: string,
  evidence: PaymentEvidence
): Promise<PaidOutcome> {
  const result = await db.execute(sql`
    UPDATE return_submissions
       SET state = 'accepted', accepted_at = now(),
           stripe_payment_intent = ${evidence.paymentIntent}
     WHERE id = ${id}
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
    .where(eq(returnSubmissions.id, id));
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

/** Expire submissions whose Stripe session can no longer be paid (24 h, plus margin). */
export async function abandonExpiredSubmissions(): Promise<string[]> {
  const result = await db.execute(sql`
    UPDATE return_submissions SET state = 'abandoned'
     WHERE state = 'awaiting_payment' AND created_at < now() - interval '25 hours'
    RETURNING id
  `);
  return rowsOf(result).map((r) => String(r.id));
}

export async function getSubmission(id: string) {
  const [submission] = await db
    .select()
    .from(returnSubmissions)
    .where(eq(returnSubmissions.id, id));
  if (!submission) return null;
  const lines = await db
    .select()
    .from(submissionLines)
    .where(eq(submissionLines.submissionId, id));
  return { submission, lines };
}

/**
 * Write the Shopify return onto the submission's lines AND onto the
 * productsorder rows, by row id, in one statement. `action` and
 * `new_variant_id` are copied from the submission, so the rows end up saying
 * what was paid for even if they were edited after checkout.
 */
export async function recordConfirmation(input: {
  submissionId: string;
  returnId: string;
  transactionId: string | null;
  transactionAmount: string | null;
  credit: boolean;
  lines: ReadonlyArray<{
    productsorderId: number;
    fulfillmentLineItemId: string;
    returnLineItemId: string;
  }>;
}): Promise<number[]> {
  const values = input.lines.map((l) => ({
    productsorder_id: l.productsorderId,
    fulfillment_line_item_id: l.fulfillmentLineItemId,
    return_line_item_id: l.returnLineItemId,
  }));
  const result = await db.execute(sql`
    WITH v AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(
        productsorder_id integer, fulfillment_line_item_id text, return_line_item_id text)
    ),
    sl AS (
      UPDATE submission_lines s
         SET fulfillment_line_item_id = v.fulfillment_line_item_id,
             return_line_item_id = v.return_line_item_id
        FROM v
       WHERE s.submission_id = ${input.submissionId}
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
           credit = CASE WHEN ${input.credit} THEN true ELSE p.credit END
      FROM sl
     WHERE p.id = sl.productsorder_id
    RETURNING p.id
  `);
  return rowsOf(result).map((r) => Number(r.id));
}
