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
import { eq, sql } from "drizzle-orm";
import db, { transact } from "@/db/drizzle";
import { getFeeTable } from "@/db/fees";
import { getProducts } from "@/db/queries";
import { orders, productsOrder } from "@/db/schema";
import type { Product } from "@/types";
import { standingReconciliations, submissionOfRow } from "./ledger";
import {
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

/**
 * D1/D2 = A: the lines Santi approved — named one by one — after the
 * reconciliation found no payment for them, recorded as ONE accepted legacy
 * submission so the ledger pays them. They must be confirmed lines of one
 * Shopify return and one tender, in no accepted submission and with no
 * standing reconciliation record. `refunded` is deliberately NOT a refusal
 * here: it is what the reconciliation proved wrong.
 */
export async function recordApprovedLegacySubmission(
  productsorderIds: number[],
  deps: LegacyDeps
): Promise<SubmissionLookup> {
  const ids = Array.from(new Set(productsorderIds)).sort((a, b) => a - b);
  if (ids.length === 0) return { ok: false, held: "nothing-approved" };
  const rows = await db.select().from(productsOrder).where(sql`${productsOrder.id} IN ${idListOf(ids)}`);
  if (rows.length !== ids.length) return { ok: false, held: "no-such-line" };
  if (rows.some((r) => r.confirmed !== true || !r.return_id || !r.return_line_item_id)) {
    return { ok: false, held: "not-confirmed" };
  }
  const orderIds = new Set(rows.map((r) => String(r.orderId)));
  if (orderIds.size !== 1) return { ok: false, held: "approved-lines-span-orders" };
  const [order] = await db.select().from(orders).where(eq(orders.id, Array.from(orderIds)[0]));
  if (!order) return { ok: false, held: "no-order" };
  for (const id of ids) {
    if (await submissionOfRow(id)) return { ok: false, held: `already-in-submission:${id}` };
  }
  const reconciled = await standingReconciliations(ids);
  if (reconciled.size > 0) {
    const [po, rec] = Array.from(reconciled)[0];
    return { ok: false, held: `reconciliation-${rec.state}:${po}` };
  }
  const all = await db.select().from(productsOrder).where(eq(productsOrder.orderId, order.id));
  const built = await legacyTerms(order, rows, all, deps);
  if (!built.ok) return built;
  await insertAccepted(order, built.terms);
  const recorded = await submissionOfRow(ids[0]);
  return recorded ? { ok: true, submissionId: recorded } : { ok: false, held: "legacy-not-recorded" };
}
