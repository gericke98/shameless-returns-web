// D1 = A — rows confirmed before S1 have no accepted submission. At
// admission (or at a cancellation, which needs the same claim) record one,
// `provenance = 'legacy'`, from the current rows with `buildAgreement`: the
// same arithmetic the portal showed (fee once per basket, credit ×1.15), the
// path S1 already uses for pre-deploy Stripe sessions. The ledger then pays it,
// so there is one writer. S3 reconciles every legacy submission against
// payment evidence.
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
import { buildAgreement } from "@/lib/agreement";
import { valueSelection } from "@/lib/basket";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { resolveFee } from "@/lib/fees";
import type { OrderItem } from "@/types";
import { readReturnFacts } from "./facts";
import { submissionOfRow } from "./ledger";

export type SubmissionLookup = { ok: true; submissionId: string } | { ok: false; held: string };

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
  const basket: typeof candidates = [];
  for (const r of candidates) {
    if (!(await submissionOfRow(r.id))) basket.push(r);
  }
  if (!basket.some((r) => r.id === row.id)) return { ok: false, held: "not-in-basket" };

  const credits = new Set(basket.map((r) => r.credit === true));
  if (credits.size !== 1) return { ok: false, held: "legacy-mixed-tender" };
  const tender = basket[0].credit === true ? "credit" : "refund";

  // Fulfillment line items from the return itself, by its return line item.
  const ret = await readReturnFacts(String(row.return_id));
  if (!ret.ok || !ret.value) return { ok: false, held: `shopify-unreadable:${row.return_id}` };
  const fulfillmentOf = ret.value.fulfillmentByReturnLine;

  const catalogue = await getProducts();
  const valued = valueSelection(basket as unknown as OrderItem[], all as unknown as OrderItem[], catalogue);
  const legs = feeLegsForOrder(await getFeeTable(), order);
  const fee = resolveFee(legs, valued);
  const agreement = buildAgreement({
    lines: valued.lines,
    returnLegCents: fee.returnLegCents,
    outboundLegCents: fee.outboundLegCents,
    feeCents: fee.feeCents,
    selfBooked: order.returnMethod === "SELF",
    tender,
  });

  const byId = new Map(basket.map((r) => [r.id, r]));
  const lines = [];
  for (const line of agreement.lines) {
    const r = byId.get(line.id)!;
    const fli = fulfillmentOf.get(String(r.return_line_item_id));
    if (!fli) return { ok: false, held: `return-line-missing:${r.id}` };
    lines.push({
      productsorder_id: r.id,
      shopify_line_item_id: r.lineItemId,
      fulfillment_line_item_id: fli,
      return_line_item_id: r.return_line_item_id,
      quantity: line.quantity,
      action: line.action,
      new_variant_id: line.action === "CAMBIO" ? r.new_variant_id : null,
      reason: r.reason,
      notes: r.notes,
      returned_cents: line.returnedCents,
      replacement_cents: line.replacementCents,
      pay_cents: line.payCents,
      stripe_funded_cents: line.stripeFundedCents,
    });
  }
  const ids = lines.map((l) => l.productsorder_id);
  const a = agreement;
  const idList = sql`(SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::int)`;

  // Two statements, one transaction: lock the rows, then insert only if no
  // accepted submission covers any of them. The insert takes a fresh snapshot
  // after the lock, so two concurrent recorders cannot both insert.
  await transact([
    sql`SELECT id FROM productsorder WHERE id IN ${idList} FOR UPDATE`,
    sql`
      WITH ins AS (
        INSERT INTO return_submissions (
          order_id, state, provenance, tender, return_method, return_leg_cents, outbound_leg_cents,
          charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
          stripe_charge_cents, waived_cents, owed_cents, residual_cents, accepted_at)
        SELECT ${order.id}, 'accepted', 'legacy', ${tender}, ${order.returnMethod ?? "LEGACY"},
               ${a.returnLegCents}, ${a.outboundLegCents}, ${a.chargedFeeCents},
               ${a.returnedValueCents}, ${a.replacementValueCents}, ${a.netCents},
               ${a.stripeChargeCents}, ${a.waivedCents}, ${a.owedCents}, ${a.residualCents}, now()
         WHERE NOT EXISTS (
           SELECT 1 FROM submission_lines sl
             JOIN return_submissions s ON s.id = sl.submission_id
             JOIN productsorder p ON p.id = sl.productsorder_id
            WHERE sl.productsorder_id IN ${idList}
              AND s.state = 'accepted'
              AND sl.return_line_item_id = p.return_line_item_id)
        RETURNING id
      )
      INSERT INTO submission_lines (
        submission_id, productsorder_id, shopify_line_item_id, fulfillment_line_item_id,
        return_line_item_id, quantity, action, new_variant_id, reason, notes, returned_cents,
        replacement_cents, pay_cents, stripe_funded_cents)
      SELECT ins.id, l.productsorder_id, l.shopify_line_item_id, l.fulfillment_line_item_id,
             l.return_line_item_id, l.quantity, l.action, l.new_variant_id, l.reason, l.notes,
             l.returned_cents, l.replacement_cents, l.pay_cents, l.stripe_funded_cents
        FROM ins, jsonb_to_recordset(${JSON.stringify(lines)}::jsonb) AS l(
          productsorder_id integer, shopify_line_item_id text, fulfillment_line_item_id text,
          return_line_item_id text, quantity integer, action text, new_variant_id text,
          reason text, notes text, returned_cents integer, replacement_cents integer,
          pay_cents integer, stripe_funded_cents integer)`,
  ]);

  const recorded = await submissionOfRow(productsorderId);
  return recorded ? { ok: true, submissionId: recorded } : { ok: false, held: "legacy-not-recorded" };
}
