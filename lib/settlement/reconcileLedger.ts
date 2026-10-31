// S3 R1 `--write`: what the reconciliation found, recorded in the ledger
// (drizzle/0009). One historical submission per Shopify return and tender, in
// the state `reconciled` — never accepted, so nothing is ever planned or paid
// from it — with one operation per line:
//
//   paid      → a `done` operation: the Shopify id as effect_ref, the
//               evidence frozen; finalization then stamps the line settled
//               and `refunded = true` (the ledger's own statements). An
//               exchange order of ours is recorded as a replacement BY ID
//               (legacy_replacement_orders) whatever its funding, and gets its
//               `replacement_lines` row only when its funding was read from
//               Stripe and allocated to the line explicitly (Codex #5) —
//               otherwise it refuses valuation and an alert says why;
//   ambiguous → an `unresolved` operation and its alert, in the same
//               statement; a human resolves it with resolve-operation.ts.
//
// No operation here is ever sent: the ledger's claim and recovery skip a
// `reconciled` submission's operations. This file moves no money and imports
// nothing that can.
//
// NOT "use server".
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import db, { transact } from "@/db/drizzle";
import type { orders } from "@/db/schema";
import { legacySubmissionCtes, type LegacyTerms } from "./legacyTerms";
import { finalizeStatements } from "./ledger";
import type { Classification, LineFacts, PaidEvidence } from "./reconcile";
import type { OpKind, ReconciliationRequest } from "./types";
import { variantGid } from "@/lib/shopifyIds";
import { fundingCommand } from "./fundingCommand";

type Order = typeof orders.$inferSelect;
const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/** The operation kind a lane's payment would have been. */
export function kindOfLane(lane: ReconciliationRequest["lane"]): OpKind {
  switch (lane) {
    case "refund":
      return "process_refund";
    case "root_refund":
      return "root_refund";
    case "credit":
      return "gift_card";
    case "exchange":
    case "native_exchange":
      return "exchange_order";
  }
}

export type ReconciledLine = {
  line: LineFacts;
  classification: Classification;
  customerGid: string | null;
};

type OpRow = {
  id: string;
  kind: OpKind;
  scope_key: string;
  members: number[];
  request: ReconciliationRequest;
  amount_cents: number;
  currency: string;
  state: "done" | "unresolved";
  effect_ref: string | null;
  evidence: unknown;
  error: string | null;
};

function effectOf(e: PaidEvidence): { ref: string; amountCents: number; currency: string } {
  switch (e.lane) {
    case "refund":
    case "root_refund":
      return { ref: e.refundId, amountCents: e.amountCents, currency: e.currency };
    case "credit":
      return { ref: e.giftCardId, amountCents: e.amountCents, currency: e.currency };
    case "exchange":
      return { ref: e.orderGid, amountCents: 0, currency: e.currency };
    case "native_exchange":
      return { ref: e.exchangeLineItemId, amountCents: 0, currency: "EUR" };
  }
}

/** A paid exchange line's Stripe funding, from a real Stripe read
 *  (lib/settlement/legacyFunding.ts) — or why it cannot be allocated. */
export type LineFunding = { ok: true; stripeFundedCents: number; source: string } | { ok: false; reason: string };

export type ReconciliationRecord = {
  submissionId: string;
  ops: OpRow[];
  replacementOrders: Array<{ order_id: string; source_order_id: string }>;
  replacementLines: Array<{
    exchange_operation_id: string;
    source_productsorder_id: number;
    order_id: string;
    line_item_id: string;
    variant_id: string;
    quantity: number;
    stripe_funded_cents: number;
  }>;
  alerts: Array<{ dedupe_key: string; subject: string; body: string }>;
};

/**
 * The rows `recordReconciliation` writes, built purely: one operation per
 * paid or ambiguous line. An exchange line's funding comes only from
 * `funding` (a Stripe read, explicitly allocated); never from the terms,
 * which carry no funding at all (legacyTerms.ts `recordedTerms`).
 */
export function reconciliationRecord(
  _terms: LegacyTerms,
  lines: ReconciledLine[],
  by: string,
  newId: () => string = randomUUID,
  funding: ReadonlyMap<number, LineFunding> = new Map()
): ReconciliationRecord {
  const submissionId = newId();
  const ops: OpRow[] = [];
  // Keyed by the exchange order's id: one order may replace several lines.
  const replacementOrders = new Map<string, ReconciliationRecord["replacementOrders"][number]>();
  const replacementLines: ReconciliationRecord["replacementLines"] = [];
  const alerts: ReconciliationRecord["alerts"] = [];
  for (const { line, classification: c, customerGid } of lines) {
    if (c.cls !== "paid" && c.cls !== "ambiguous") continue;
    if (!c.lane) continue;
    // The lane of the effect found (a replacement line may be paid by a
    // refund on its own return), else the lane its writer would have taken.
    const lane: ReconciliationRequest["lane"] = c.evidence?.lane ?? c.lane;
    const id = newId();
    const request: ReconciliationRequest = {
      kind: "reconciliation",
      lane,
      check: {
        orderNumber: line.orderNumber,
        returnId: String(line.returnId ?? ""),
        returnLineItemId: String(line.returnLineItemId ?? ""),
        lineItemId: line.lineItemId,
        customerGid,
        newVariantGid: c.evidence?.lane === "exchange" || c.evidence?.lane === "native_exchange"
          ? c.evidence.variantGid
          : variantGid(line.newVariantId),
        quantity: line.quantity,
        giftCardId: line.giftCardId,
      },
      classified: { cls: c.cls, reason: c.reason },
    };
    const scope = `reconcile:${submissionId}:${line.productsorderId}`;
    if (c.cls === "paid" && c.evidence) {
      const effect = effectOf(c.evidence);
      ops.push({
        id,
        kind: kindOfLane(lane),
        scope_key: scope,
        members: [line.productsorderId],
        request,
        amount_cents: effect.amountCents,
        currency: effect.currency,
        state: "done",
        effect_ref: effect.ref,
        evidence: { reconciliation: c.evidence, by },
        error: null,
      });
      if (c.evidence.lane === "exchange") {
        const orderId = c.evidence.orderGid.replace(/^gid:\/\/shopify\/Order\//, "");
        replacementOrders.set(orderId, { order_id: orderId, source_order_id: line.orderId });
        const f = funding.get(line.productsorderId) ?? { ok: false as const, reason: "funding not read" };
        if (f.ok) {
          replacementLines.push({
            exchange_operation_id: id,
            source_productsorder_id: line.productsorderId,
            order_id: orderId,
            line_item_id: c.evidence.lineItemId,
            variant_id: c.evidence.variantGid,
            quantity: c.evidence.quantity,
            stripe_funded_cents: f.stripeFundedCents,
          });
        } else {
          alerts.push({
            dedupe_key: `replacement-unfunded:${orderId}`,
            subject: `[returns] LEGACY EXCHANGE ORDER UNFUNDED — ${c.evidence.orderName || orderId}`,
            body: [
              `${c.evidence.orderName || orderId} is the exchange order for ${line.orderNumber} (productsorder ${line.productsorderId}).`,
              `Its Stripe funding could not be allocated to the line: ${f.reason}.`,
              `It is recorded as a replacement order, so a return on it is refused online (never priced at list)`,
              `until its funding is recorded. Nothing was paid or computed.`,
              `To record it from the customer's pre-S1 Stripe payment:`,
              fundingCommand(orderId, line.productsorderId),
            ].join("\n"),
          });
        }
      }
    } else {
      ops.push({
        id,
        kind: kindOfLane(lane),
        scope_key: scope,
        members: [line.productsorderId],
        request,
        amount_cents: 0,
        currency: "EUR",
        state: "unresolved",
        effect_ref: null,
        evidence: null,
        error: c.reason.slice(0, 2000),
      });
      alerts.push({
        dedupe_key: `settlement-unresolved:${id}`,
        subject: `[returns] LEGACY PAYMENT UNCLEAR — ${line.orderNumber} line ${line.productsorderId}`,
        body: [
          `The legacy reconciliation could not tell whether ${line.orderNumber} (productsorder ${line.productsorderId},`,
          `${lane}) was paid before the settlement ledger existed.`,
          `Why: ${c.reason}`,
          `Return: ${line.returnId ?? "(none)"}`,
          ``,
          `Nothing will pay this line until a human decides. Look in Shopify, then run`,
          `scripts/resolve-operation.ts --op ${id} with --done (the payment you found)`,
          `or --rejected (no payment happened: the line then goes on the approval CSV).`,
        ].join("\n"),
      });
    }
  }
  return { submissionId, ops, replacementOrders: Array.from(replacementOrders.values()), replacementLines, alerts };
}

/**
 * ONE transaction: lock the rows; insert the reconciled submission, its lines,
 * its operations, the replacement lines and the alerts — only if no operation
 * of any kind already covers these rows (an operator's rejected reconciliation
 * record excepted) — then finalize. Re-running is a no-op.
 */
export async function recordReconciliation(
  order: Order,
  terms: LegacyTerms,
  record: ReconciliationRecord
): Promise<{ recorded: boolean; settled: number[] }> {
  if (record.ops.length === 0) return { recorded: false, settled: [] };
  const members = Array.from(new Set(record.ops.flatMap((o) => o.members)));
  const covered = new Set(members);
  // The submission holds exactly the lines it records.
  const recordedTerms: LegacyTerms = { ...terms, lines: terms.lines.filter((l) => covered.has(l.productsorder_id)) };
  if (recordedTerms.lines.length !== members.length) {
    throw new Error(`reconciliation for ${order.orderNumber}: a recorded line is missing from its terms`);
  }
  const ids = sql`(SELECT (jsonb_array_elements_text(${JSON.stringify(members)}::jsonb))::int)`;
  const guard = sql`NOT EXISTS (
           SELECT 1 FROM settlement_operations o
             JOIN return_submissions s ON s.id = o.submission_id
            WHERE o.members && ARRAY${ids}
              AND NOT (s.state = 'reconciled' AND o.state = 'rejected')
              AND s.state <> 'voided')`;
  const ctes = legacySubmissionCtes(order, recordedTerms, "reconciled", guard, record.submissionId);
  const [, main, settledLines] = await transact([
    sql`SELECT id FROM productsorder WHERE id IN ${ids} FOR UPDATE`,
    sql`
      WITH ${ctes},
      ops AS (
        INSERT INTO settlement_operations
          (id, submission_id, kind, scope_key, members, request, amount_cents, currency,
           state, effect_ref, evidence, error, resolved_by)
        SELECT o.id, ins.id, o.kind, o.scope_key, o.members, o.request, o.amount_cents, o.currency,
               o.state, o.effect_ref, o.evidence, o.error, 'reconcile-legacy'
          FROM ins, jsonb_to_recordset(${JSON.stringify(record.ops)}::jsonb) AS o(
            id uuid, kind text, scope_key text, members integer[], request jsonb, amount_cents integer,
            currency text, state text, effect_ref text, evidence jsonb, error text)
        RETURNING 1
      ),
      rl AS (
        INSERT INTO replacement_lines
          (exchange_operation_id, source_submission_id, source_productsorder_id, order_id,
           line_item_id, variant_id, quantity, stripe_funded_cents)
        SELECT r.exchange_operation_id, ins.id, r.source_productsorder_id, r.order_id,
               r.line_item_id, r.variant_id, r.quantity, r.stripe_funded_cents
          FROM ins, jsonb_to_recordset(${JSON.stringify(record.replacementLines)}::jsonb) AS r(
            exchange_operation_id uuid, source_productsorder_id integer, order_id text,
            line_item_id text, variant_id text, quantity integer, stripe_funded_cents integer)
        RETURNING 1
      ),
      ident AS (
        INSERT INTO legacy_replacement_orders (order_id, source_order_id, found_by)
        SELECT r.order_id, r.source_order_id, 'reconciliation'
          FROM ins, jsonb_to_recordset(${JSON.stringify(record.replacementOrders)}::jsonb) AS r(
            order_id text, source_order_id text)
        ON CONFLICT (order_id) DO UPDATE
          SET source_order_id = COALESCE(legacy_replacement_orders.source_order_id, EXCLUDED.source_order_id)
        RETURNING 1
      ),
      alerts AS (
        INSERT INTO ops_alerts (dedupe_key, subject, body)
        SELECT a.dedupe_key, a.subject, a.body
          FROM ins, jsonb_to_recordset(${JSON.stringify(record.alerts)}::jsonb) AS a(
            dedupe_key text, subject text, body text)
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING 1
      )
      SELECT ins.id::text AS id, (SELECT count(*) FROM ops)::int AS ops,
             (SELECT count(*) FROM rl)::int AS rl, (SELECT count(*) FROM ident)::int AS ident,
             (SELECT count(*) FROM alerts)::int AS alerts
        FROM ins`,
    ...finalizeStatements(record.submissionId),
  ]);
  const recorded = (main ?? []).length === 1;
  return { recorded, settled: recorded ? (settledLines ?? []).map((r: any) => Number(r.productsorder_id)) : [] };
}

/** Rows R1 must not walk: any operation covers them, except an operator's
 *  rejected reconciliation record (those are reported back as unpaid).
 *  `swapCandidates` are the covered rows whose only cover is a done
 *  reconciliation exchange_order — the settled exchanges R2 lists for a
 *  possible owed difference (D1). */
export async function reconciliationCoverage(): Promise<{
  covered: Set<number>;
  rejected: Map<number, string>;
  swapCandidates: Set<number>;
}> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT m.po, o.id, o.state, o.kind, s.state AS submission_state
        FROM settlement_operations o
        JOIN return_submissions s ON s.id = o.submission_id
        CROSS JOIN LATERAL unnest(o.members) AS m(po)
       -- A voided record (drizzle/0012) covers nothing: it never stood.
       WHERE s.state <> 'voided'
    `)
  );
  const covered = new Set<number>();
  const rejected = new Map<number, string>();
  const doneExchange = new Set<number>();
  const other = new Set<number>();
  for (const r of rows) {
    const po = Number(r.po);
    if (r.submission_state === "reconciled" && r.state === "rejected") {
      rejected.set(po, String(r.id));
      continue;
    }
    covered.add(po);
    if (r.submission_state === "reconciled" && r.state === "done" && r.kind === "exchange_order") doneExchange.add(po);
    else other.add(po);
  }
  for (const po of Array.from(covered)) rejected.delete(po);
  const swapCandidates = new Set(Array.from(doneExchange).filter((po) => !other.has(po)));
  return { covered, rejected, swapCandidates };
}
