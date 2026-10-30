// S3, Santi 30 Oct (A): an operator records ONE legacy exchange line's Stripe
// funding, on demand — when the portal refuses a return on that replacement
// order because it has no funding (actions/replacementOrder.ts).
//
// Pre-S1 checkout sessions carry `metadata.id` = the order they paid for and
// no per-line split, so the reconciliation cannot allocate a paid session by
// identity (lib/settlement/legacyFunding.ts). The operator states the amount;
// this checks it against what Stripe and the ledger say, explicitly:
//   - the replacement order is the effect of a DONE reconciled exchange_order
//     operation for that source line (R1's or an operator's), so the order and
//     the line are already identified;
//   - the line is not funded yet;
//   - the session, read from Stripe, is paid, pre-S1 (no submission id), and
//     its metadata.id names the source order;
//   - 0 < cents ≤ the session's amount_total − what earlier decisions took;
//   - the replacement order, read from Shopify, passes judgeLegacyExchangeOrder
//     for the operation's frozen check — its real line item is what is funded.
// Then ONE statement writes the decision (who, why, the session and its
// total) and the replacement_lines row, re-checking the session budget and
// "not funded yet" under the statement's own snapshot.
//
// Stripe and Shopify are only READ. NOT "use server".
import { sql } from "drizzle-orm";
import db from "@/db/drizzle";
import { parseCheckoutMetadata } from "@/lib/checkoutMetadata";
import { read } from "./reads";
import { judgeLegacyExchangeOrder } from "./reconcile";
import { RECONCILE_ORDER_QUERY } from "./reconcileReads";
import { reconciliationRequestOf } from "./types";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export type FundingDecisionInput = {
  /** The replacement order, bare Shopify id. */
  orderId: string;
  /** The productsorder line it replaced. */
  productsorderId: number;
  stripeSessionId: string;
  fundedCents: number;
  by: string;
  evidence: string;
};

export type StripeSessionRead =
  | { ok: true; session: { id: string; payment_status: string | null; amount_total: number | null; metadata: Record<string, string | undefined> | null } | null }
  | { ok: false; error: string };

export function fundingDecisionProblem(d: FundingDecisionInput): string | null {
  if (!/^[0-9]+$/.test(d.orderId)) return "--order must be the replacement order's bare Shopify id";
  if (!Number.isInteger(d.productsorderId) || d.productsorderId <= 0) return "--line must be a productsorder id";
  if (!d.stripeSessionId.trim()) return "--session is required";
  if (!Number.isInteger(d.fundedCents) || d.fundedCents <= 0) return "--cents must be an integer > 0";
  if (!d.by.trim()) return "who decided (--by) is required";
  if (!d.evidence.trim()) return "the evidence (--evidence) is required";
  return null;
}

export type FundingOutcome =
  | { ok: true; written: boolean; summary: string }
  | { ok: false; reason: string };

export async function fundReplacementLine(
  d: FundingDecisionInput,
  readSession: (id: string) => Promise<StripeSessionRead>,
  options: { write: boolean }
): Promise<FundingOutcome> {
  const problem = fundingDecisionProblem(d);
  if (problem) return { ok: false, reason: problem };
  const orderGid = `gid://shopify/Order/${d.orderId}`;

  // The done reconciled exchange record that identifies order and line.
  const ops = rowsOf(
    await db.execute(sql`
      SELECT o.id, o.submission_id, o.request, s.order_id AS source_order_id
        FROM settlement_operations o
        JOIN return_submissions s ON s.id = o.submission_id AND s.state = 'reconciled'
       WHERE o.kind = 'exchange_order' AND o.state = 'done'
         AND o.effect_ref = ${orderGid}
         AND ${d.productsorderId} = ANY (o.members)`)
  );
  if (ops.length !== 1) {
    return { ok: false, reason: `${ops.length} done reconciled exchange records name order ${d.orderId} for line ${d.productsorderId}` };
  }
  const op = ops[0];
  const sourceOrderId = String(op.source_order_id);
  const [funded] = rowsOf(
    await db.execute(sql`
      SELECT 1 FROM replacement_lines
       WHERE exchange_operation_id = ${op.id} AND source_productsorder_id = ${d.productsorderId}`)
  );
  if (funded) return { ok: false, reason: `line ${d.productsorderId} of order ${d.orderId} is already funded` };

  // The Stripe session.
  const s = await readSession(d.stripeSessionId);
  if (!s.ok) return { ok: false, reason: `Stripe unreadable: ${s.error}` };
  if (!s.session) return { ok: false, reason: `no Stripe session ${d.stripeSessionId}` };
  if (s.session.payment_status !== "paid") return { ok: false, reason: `session ${d.stripeSessionId} is not paid (${s.session.payment_status})` };
  const meta = parseCheckoutMetadata(s.session.metadata);
  if (meta?.submissionId) return { ok: false, reason: `session ${d.stripeSessionId} belongs to a submission: not a pre-S1 payment` };
  if (meta?.id !== sourceOrderId) {
    return { ok: false, reason: `session ${d.stripeSessionId} names order ${meta?.id ?? "(none)"}, not the source order ${sourceOrderId}` };
  }
  const total = Number(s.session.amount_total);
  if (!Number.isInteger(total) || total <= 0) return { ok: false, reason: `session ${d.stripeSessionId} has no amount_total` };
  const [used] = rowsOf(
    await db.execute(sql`
      SELECT COALESCE(sum(funded_cents), 0)::int AS used FROM replacement_funding_decisions
       WHERE stripe_session_id = ${d.stripeSessionId}`)
  );
  const left = total - Number(used?.used ?? 0);
  if (d.fundedCents > left) {
    return { ok: false, reason: `${d.fundedCents} exceeds what session ${d.stripeSessionId} has left: ${left} of ${total}` };
  }

  // The replacement order's real line, judged as the operator's done is.
  const check = reconciliationRequestOf(op.request)?.check;
  if (!check) return { ok: false, reason: `operation ${op.id} is not a reconciliation record` };
  const r = await read(RECONCILE_ORDER_QUERY, { id: orderGid }, (x) => x?.order ?? null);
  if (!r.ok) return { ok: false, reason: `Shopify unreadable: ${r.error}` };
  const judged = judgeLegacyExchangeOrder(check, r.value);
  if (!judged.ok) return { ok: false, reason: `order ${d.orderId} is not this line's exchange: ${judged.reason}` };

  const summary =
    `fund line ${d.productsorderId} → ${judged.lineItemId} on order ${d.orderId}: ${d.fundedCents} cents ` +
    `from ${d.stripeSessionId} (${left} of ${total} left), by ${d.by}`;
  if (!options.write) return { ok: true, written: false, summary: `would ${summary}` };

  const rows = rowsOf(
    await db.execute(sql`
      WITH budget AS (
        SELECT COALESCE(sum(funded_cents), 0) AS used FROM replacement_funding_decisions
         WHERE stripe_session_id = ${d.stripeSessionId}
      ),
      decision AS (
        INSERT INTO replacement_funding_decisions
          (order_id, source_productsorder_id, stripe_session_id, session_amount_cents, funded_cents, decided_by, evidence)
        SELECT ${d.orderId}, ${d.productsorderId}, ${d.stripeSessionId}, ${total}, ${d.fundedCents}, ${d.by}, ${d.evidence}
          FROM budget
         WHERE budget.used + ${d.fundedCents} <= ${total}
           AND NOT EXISTS (SELECT 1 FROM replacement_lines
                            WHERE exchange_operation_id = ${op.id} AND source_productsorder_id = ${d.productsorderId})
        ON CONFLICT (order_id, source_productsorder_id) DO NOTHING
        RETURNING id
      ),
      rl AS (
        INSERT INTO replacement_lines
          (exchange_operation_id, source_submission_id, source_productsorder_id, order_id,
           line_item_id, variant_id, quantity, stripe_funded_cents)
        SELECT ${op.id}, ${op.submission_id}, ${d.productsorderId}, ${d.orderId},
               ${judged.lineItemId}, ${judged.variantGid}, ${judged.quantity}, ${d.fundedCents}
          FROM decision
        RETURNING 1
      ),
      ident AS (
        INSERT INTO legacy_replacement_orders (order_id, source_order_id, found_by)
        SELECT ${d.orderId}, ${sourceOrderId}, 'operator' FROM decision
        ON CONFLICT (order_id) DO UPDATE
          SET source_order_id = COALESCE(legacy_replacement_orders.source_order_id, EXCLUDED.source_order_id)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM decision)::int AS decided, (SELECT count(*) FROM rl)::int AS lines`)
  );
  const decided = Number(rows[0]?.decided ?? 0) === 1 && Number(rows[0]?.lines ?? 0) === 1;
  return decided
    ? { ok: true, written: true, summary }
    : { ok: false, reason: "not written: the line was funded, or the session's budget used, meanwhile" };
}
