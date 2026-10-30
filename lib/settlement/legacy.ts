// D1 = A — rows confirmed before S1 have no accepted submission. At
// admission (or at a cancellation, which needs the same claim) record one,
// `provenance = 'legacy'`, from the current rows with `buildAgreement`: the
// same arithmetic the portal showed (fee once per basket, credit ×1.15), the
// path S1 already uses for pre-deploy Stripe sessions. The ledger then pays it,
// so there is one writer.
//
// S3 reuses the same terms twice (scripts/reconcile-legacy.ts):
//  * a line Santi APPROVED for payment after the reconciliation found no
//    payment for it (D1/D2 = A) gets its accepted legacy submission here —
//    `recordApprovedLegacySubmission` — even if `refunded` is already set,
//    because `refunded` was never evidence of payment;
//  * the reconciliation's own records (a `reconciled` submission) are built
//    from `legacyTerms` too (lib/settlement/reconcileLedger.ts).
//
// The basket is the rows of ONE Shopify return (one parcel): confirmed, not
// yet settled, and not already part of an accepted submission.
//
// NOT "use server".
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import db, { transact } from "@/db/drizzle";
import { getFeeTable } from "@/db/fees";
import { getProducts } from "@/db/queries";
import { orders, productsOrder } from "@/db/schema";
import type { Product } from "@/types";
import { standingReconciliations, submissionOfRow, type ApprovalBasis } from "./ledger";
import {
  approvedTerms,
  idListOf,
  legacySubmissionCtes,
  legacyTerms,
  noAcceptedSubmission,
  noStandingReconciliation,
  type LegacyDeps,
  type LegacyTerms,
} from "./legacyTerms";

export type { LegacyDeps } from "./legacyTerms";

export type SubmissionLookup = { ok: true; submissionId: string } | { ok: false; held: string };

type Order = typeof orders.$inferSelect;

const appDeps: LegacyDeps = { feeTable: getFeeTable, catalogue: getProducts as () => Promise<Product[]> };

/**
 * Two statements, one transaction: lock the rows, then insert only if no
 * accepted submission and no standing reconciliation record covers any of
 * them. The insert takes a fresh snapshot after the lock, so two concurrent
 * recorders cannot both insert.
 */
async function insertAccepted(order: Order, terms: LegacyTerms): Promise<void> {
  const ids = terms.lines.map((l) => l.productsorder_id);
  await transact([
    sql`SELECT id FROM productsorder WHERE id IN ${idListOf(ids)} FOR UPDATE`,
    sql`WITH ${legacySubmissionCtes(
      order,
      terms,
      "accepted",
      sql`${noAcceptedSubmission(ids)} AND ${noStandingReconciliation(ids)}`
    )} SELECT count(*)::int AS n FROM ins`,
  ]);
}

/** The accepted submission a row belongs to, recording a legacy one if none does. */
export async function submissionForRow(productsorderId: number): Promise<SubmissionLookup> {
  const existing = await submissionOfRow(productsorderId);
  if (existing) return { ok: true, submissionId: existing };
  return recordLegacySubmissionFor(productsorderId);
}

async function recordLegacySubmissionFor(productsorderId: number): Promise<SubmissionLookup> {
  const [row] = await db.select().from(productsOrder).where(eq(productsOrder.id, productsorderId));
  if (!row) return { ok: false, held: "no-such-line" };
  if (row.confirmed !== true || !row.return_id || !row.return_line_item_id) {
    return { ok: false, held: "not-confirmed" };
  }
  if (row.refunded) return { ok: false, held: "already-refunded" };
  const [order] = await db.select().from(orders).where(eq(orders.id, String(row.orderId)));
  if (!order) return { ok: false, held: "no-order" };

  const all = await db.select().from(productsOrder).where(eq(productsOrder.orderId, order.id));
  // The parcel: this row's Shopify return, unsettled, not yet in a submission.
  const candidates = all.filter(
    (r) => r.confirmed === true && r.return_id === row.return_id && !r.refunded && r.action && r.return_line_item_id
  );
  // S3: a row the reconciliation found paid, or left for a human, is never
  // put in a submission that would pay it.
  const reconciled = await standingReconciliations(candidates.map((r) => r.id));
  if (reconciled.has(row.id)) return { ok: false, held: `reconciliation-${reconciled.get(row.id)!.state}` };
  const basket: typeof candidates = [];
  for (const r of candidates) {
    if (!reconciled.has(r.id) && !(await submissionOfRow(r.id))) basket.push(r);
  }
  if (!basket.some((r) => r.id === row.id)) return { ok: false, held: "not-in-basket" };

  const built = await legacyTerms(order, basket, all, appDeps);
  if (!built.ok) return built;
  await insertAccepted(order, built.terms);

  const recorded = await submissionOfRow(productsorderId);
  return recorded ? { ok: true, submissionId: recorded } : { ok: false, held: "legacy-not-recorded" };
}

/** One line Santi approved, with the amount HE stated (never computed). */
export type ApprovalInput = {
  productsorderId: number;
  basis: ApprovalBasis;
  amountCents: number;
  /** returned − replacement at approval time: the most it may pay. */
  capCents: number;
  approvedBy: string;
};

/** The amount rule, before anything is written (0010 enforces it again). */
export function approvalProblem(a: ApprovalInput): string | null {
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) return `amount must be an integer > 0 (${a.amountCents})`;
  if (!Number.isInteger(a.capCents) || a.amountCents > a.capCents) {
    return `amount ${a.amountCents} exceeds returned − replacement = ${a.capCents}`;
  }
  if (!a.approvedBy.trim()) return "approved_by is required";
  return null;
}

/**
 * D1/D2 = A, and Santi's "you set each amount" (30 Oct): the lines he
 * approved, each with the amount he stated, recorded as ONE accepted legacy
 * submission whose lines pay exactly those amounts — and each approval row
 * (drizzle/0010) in the same statement. They must be confirmed lines of one
 * Shopify return and one tender, in no accepted submission and with no
 * standing reconciliation record (a `swap` approval over a done exchange
 * record excepted). `refunded` is deliberately NOT a refusal here: it is what
 * the reconciliation proved wrong.
 */
export async function recordApprovedLegacySubmission(approvals: ApprovalInput[]): Promise<SubmissionLookup> {
  const ids = approvals.map((a) => a.productsorderId).sort((a, b) => a - b);
  if (ids.length === 0) return { ok: false, held: "nothing-approved" };
  if (new Set(ids).size !== ids.length) return { ok: false, held: "duplicate-approval" };
  for (const a of approvals) {
    const problem = approvalProblem(a);
    if (problem) return { ok: false, held: `approval-invalid:${a.productsorderId}:${problem}` };
  }
  const rows = await db.select().from(productsOrder).where(sql`${productsOrder.id} IN ${idListOf(ids)}`);
  if (rows.length !== ids.length) return { ok: false, held: "no-such-line" };
  if (rows.some((r) => r.confirmed !== true || !r.return_id || !r.return_line_item_id || !r.action)) {
    return { ok: false, held: "not-confirmed" };
  }
  const orderIds = new Set(rows.map((r) => String(r.orderId)));
  if (orderIds.size !== 1) return { ok: false, held: "approved-lines-span-orders" };
  const [order] = await db.select().from(orders).where(eq(orders.id, Array.from(orderIds)[0]));
  if (!order) return { ok: false, held: "no-order" };
  for (const id of ids) {
    if (await submissionOfRow(id)) return { ok: false, held: `already-in-submission:${id}` };
  }
  const bases = new Map(approvals.map((a) => [a.productsorderId, a.basis]));
  const reconciled = await standingReconciliations(ids, bases);
  if (reconciled.size > 0) {
    const [po, rec] = Array.from(reconciled)[0];
    return { ok: false, held: `reconciliation-${rec.state}:${po}` };
  }
  const built = await approvedTerms(rows, approvals);
  if (!built.ok) return built;

  const submissionId = randomUUID();
  const records = approvals.map((a) => ({
    productsorder_id: a.productsorderId,
    basis: a.basis,
    amount_cents: a.amountCents,
    cap_cents: a.capCents,
    approved_by: a.approvedBy,
  }));
  // Every approved line held by a standing record, but for the swap exception.
  const stillHeld = sql`NOT EXISTS (
           SELECT 1 FROM settlement_operations o
             JOIN return_submissions rs ON rs.id = o.submission_id AND rs.state = 'reconciled'
             JOIN jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS a(productsorder_id integer, basis text)
               ON a.productsorder_id = ANY (o.members)
            WHERE o.state <> 'rejected'
              AND NOT (a.basis = 'swap' AND o.state = 'done' AND o.kind = 'exchange_order'))`;
  await transact([
    sql`SELECT id FROM productsorder WHERE id IN ${idListOf(ids)} FOR UPDATE`,
    sql`WITH ${legacySubmissionCtes(
      order,
      built.terms,
      "accepted",
      sql`${noAcceptedSubmission(ids)} AND ${stillHeld}`,
      submissionId
    )},
      approvals AS (
        INSERT INTO settlement_approvals (productsorder_id, submission_id, basis, amount_cents, cap_cents, approved_by)
        SELECT a.productsorder_id, ins.id, a.basis, a.amount_cents, a.cap_cents, a.approved_by
          FROM ins, jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS a(
            productsorder_id integer, basis text, amount_cents integer, cap_cents integer, approved_by text)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM ins)::int AS n, (SELECT count(*) FROM approvals)::int AS a`,
  ]);
  const recorded = await submissionOfRow(ids[0]);
  return recorded === submissionId ? { ok: true, submissionId } : { ok: false, held: "legacy-not-recorded" };
}
