// The legacy agreement (S2 D1 = A), as data: the terms a pre-S1 basket is
// recorded with, and the CTEs that record them. Shared by lib/settlement/
// legacy.ts (admission, and Santi's approved lines, S3 D1/D2 = A) and
// lib/settlement/reconcileLedger.ts (the reconciliation's records, S3 R1).
//
// Imports nothing request-bound: the fee table and the catalogue come in as
// `deps`, so a script outside Next can build the same terms.
//
// NOT "use server".
import { sql, type SQL } from "drizzle-orm";
import type { orders, productsOrder } from "@/db/schema";
import { buildAgreement, type Agreement } from "@/lib/agreement";
import { valueSelection } from "@/lib/basket";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { resolveFee, type FeeTable } from "@/lib/fees";
import type { OrderItem, Product } from "@/types";
import { readReturnFacts } from "./facts";

type Row = typeof productsOrder.$inferSelect;
type Order = typeof orders.$inferSelect;

export const idListOf = (ids: number[]) =>
  sql`(SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::int)`;

/** Where the legacy terms read the fee table and the catalogue from. The app
 *  passes its cached readers; a script outside Next passes uncached ones. */
export type LegacyDeps = {
  feeTable: () => Promise<FeeTable>;
  catalogue: () => Promise<Product[]>;
};

/** One submission line, as `submission_lines` stores it. */
export type LegacyLine = {
  productsorder_id: number;
  shopify_line_item_id: string;
  fulfillment_line_item_id: string;
  return_line_item_id: string | null;
  quantity: number;
  action: string;
  new_variant_id: string | null;
  reason: string | null;
  notes: string | null;
  returned_cents: number;
  replacement_cents: number;
  pay_cents: number;
  stripe_funded_cents: number;
};

export type LegacyTerms = { agreement: Agreement; lines: LegacyLine[]; tender: "refund" | "credit" };

/**
 * The legacy agreement for `basket` — rows of ONE Shopify return, one tender —
 * from the current rows, the fee table and the catalogue: the arithmetic the
 * portal shows, once per basket.
 */
export async function legacyTerms(
  order: Order,
  basket: Row[],
  all: Row[],
  deps: LegacyDeps
): Promise<{ ok: true; terms: LegacyTerms } | { ok: false; held: string }> {
  if (basket.length === 0) return { ok: false, held: "empty-basket" };
  const returns = new Set(basket.map((r) => r.return_id));
  if (returns.size !== 1 || !basket[0].return_id) return { ok: false, held: "legacy-not-one-return" };
  if (basket.some((r) => !r.action || !r.return_line_item_id)) return { ok: false, held: "legacy-incomplete-line" };
  const credits = new Set(basket.map((r) => r.credit === true));
  if (credits.size !== 1) return { ok: false, held: "legacy-mixed-tender" };
  const tender = basket[0].credit === true ? "credit" : "refund";

  // Fulfillment line items from the return itself, by its return line item.
  const returnId = String(basket[0].return_id);
  const ret = await readReturnFacts(returnId);
  if (!ret.ok || !ret.value) return { ok: false, held: `shopify-unreadable:${returnId}` };
  const fulfillmentOf = ret.value.fulfillmentByReturnLine;

  const catalogue = await deps.catalogue();
  const valued = valueSelection(basket as unknown as OrderItem[], all as unknown as OrderItem[], catalogue);
  const legs = feeLegsForOrder(await deps.feeTable(), order);
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
  const lines: LegacyLine[] = [];
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
  return { ok: true, terms: { agreement, lines, tender } };
}

/** No accepted submission covers any of these rows (by their return line item). */
export const noAcceptedSubmission = (ids: number[]) => sql`NOT EXISTS (
           SELECT 1 FROM submission_lines sl
             JOIN return_submissions s ON s.id = sl.submission_id
             JOIN productsorder p ON p.id = sl.productsorder_id
            WHERE sl.productsorder_id IN ${idListOf(ids)}
              AND s.state = 'accepted'
              AND sl.return_line_item_id = p.return_line_item_id)`;

/** No standing reconciliation record (done or unresolved) covers any of these rows. */
export const noStandingReconciliation = (ids: number[]) => sql`NOT EXISTS (
           SELECT 1 FROM settlement_operations o
             JOIN return_submissions s ON s.id = o.submission_id AND s.state = 'reconciled'
            WHERE o.state <> 'rejected'
              AND o.members && ARRAY${idListOf(ids)})`;

/**
 * The `ins` and `lines` CTEs: the submission (in `state`) and its lines,
 * inserted only when `guard` holds. Callers follow them with their own CTEs
 * and a final SELECT.
 */
export function legacySubmissionCtes(
  order: Order,
  terms: LegacyTerms,
  state: "accepted" | "reconciled",
  guard: SQL,
  /** The submission's id when the caller must name it; Postgres picks one otherwise. */
  id?: string
): SQL {
  const a = terms.agreement;
  return sql`
      ins AS (
        INSERT INTO return_submissions (
          id, order_id, state, provenance, tender, return_method, return_leg_cents, outbound_leg_cents,
          charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
          stripe_charge_cents, waived_cents, owed_cents, residual_cents, accepted_at)
        SELECT ${id ? sql`${id}::uuid` : sql`gen_random_uuid()`}, ${order.id}, ${state}, 'legacy', ${terms.tender}, ${order.returnMethod ?? "LEGACY"},
               ${a.returnLegCents}, ${a.outboundLegCents}, ${a.chargedFeeCents},
               ${a.returnedValueCents}, ${a.replacementValueCents}, ${a.netCents},
               ${a.stripeChargeCents}, ${a.waivedCents}, ${a.owedCents}, ${a.residualCents}, now()
         WHERE ${guard}
        RETURNING id
      ),
      lines AS (
        INSERT INTO submission_lines (
          submission_id, productsorder_id, shopify_line_item_id, fulfillment_line_item_id,
          return_line_item_id, quantity, action, new_variant_id, reason, notes, returned_cents,
          replacement_cents, pay_cents, stripe_funded_cents)
        SELECT ins.id, l.productsorder_id, l.shopify_line_item_id, l.fulfillment_line_item_id,
               l.return_line_item_id, l.quantity, l.action, l.new_variant_id, l.reason, l.notes,
               l.returned_cents, l.replacement_cents, l.pay_cents, l.stripe_funded_cents
          FROM ins, jsonb_to_recordset(${JSON.stringify(terms.lines)}::jsonb) AS l(
            productsorder_id integer, shopify_line_item_id text, fulfillment_line_item_id text,
            return_line_item_id text, quantity integer, action text, new_variant_id text,
            reason text, notes text, returned_cents integer, replacement_cents integer,
            pay_cents integer, stripe_funded_cents integer)
        RETURNING 1
      )`;
}

/**
 * The terms of an APPROVED legacy payment (S3, Santi 30 Oct: "you set each
 * amount"): each line pays exactly the amount Santi stated, in the line's
 * tender — nothing is valued, no fee is charged and no ×1.15 applied, because
 * the stated amount already is the payment. returned − replacement − fee =
 * net holds by construction (replacement = returned − amount, fee 0).
 */
export async function approvedTerms(
  basket: Row[],
  approvals: ReadonlyArray<{ productsorderId: number; amountCents: number }>
): Promise<{ ok: true; terms: LegacyTerms } | { ok: false; held: string }> {
  if (basket.length === 0) return { ok: false, held: "empty-basket" };
  const returns = new Set(basket.map((r) => r.return_id));
  if (returns.size !== 1 || !basket[0].return_id) return { ok: false, held: "legacy-not-one-return" };
  if (basket.some((r) => !r.action || !r.return_line_item_id)) return { ok: false, held: "legacy-incomplete-line" };
  const credits = new Set(basket.map((r) => r.credit === true));
  if (credits.size !== 1) return { ok: false, held: "legacy-mixed-tender" };
  const tender = basket[0].credit === true ? "credit" : "refund";
  const amount = new Map(approvals.map((a) => [a.productsorderId, a.amountCents]));

  const returnId = String(basket[0].return_id);
  const ret = await readReturnFacts(returnId);
  if (!ret.ok || !ret.value) return { ok: false, held: `shopify-unreadable:${returnId}` };

  const lines: LegacyLine[] = [];
  for (const r of basket) {
    const pay = amount.get(r.id);
    if (pay === undefined) return { ok: false, held: `not-approved:${r.id}` };
    const fli = ret.value.fulfillmentByReturnLine.get(String(r.return_line_item_id));
    if (!fli) return { ok: false, held: `return-line-missing:${r.id}` };
    const returned = Math.round(Number(r.price) * 100) * r.quantity;
    lines.push({
      productsorder_id: r.id,
      shopify_line_item_id: r.lineItemId,
      fulfillment_line_item_id: fli,
      return_line_item_id: r.return_line_item_id,
      quantity: r.quantity,
      action: String(r.action),
      new_variant_id: r.action === "CAMBIO" ? r.new_variant_id : null,
      reason: r.reason,
      notes: r.notes,
      returned_cents: returned,
      replacement_cents: returned - pay,
      pay_cents: pay,
      stripe_funded_cents: 0,
    });
  }
  const sum = (f: (l: LegacyLine) => number) => lines.reduce((t, l) => t + f(l), 0);
  const paid = sum((l) => l.pay_cents);
  const agreement = {
    tender,
    returnLegCents: 0,
    outboundLegCents: 0,
    chargedFeeCents: 0,
    returnedValueCents: sum((l) => l.returned_cents),
    replacementValueCents: sum((l) => l.replacement_cents),
    netCents: paid,
    stripeChargeCents: 0,
    waivedCents: 0,
    owedCents: paid,
    residualCents: 0,
    lines: [],
  } as unknown as Agreement;
  return { ok: true, terms: { agreement, lines, tender } };
}
