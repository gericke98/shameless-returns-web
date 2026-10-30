// An operator's decision on an `unresolved` operation (S2 plan L5), used by
// scripts/resolve-operation.ts.
//
// A human decides WHETHER the effect happened; what it left behind is still
// read from Shopify and judged by the same predicate the runner uses, so an
// operator's `done` writes exactly the records the runner's would (finding 5):
//   exchange_order — the operator names the order they found; it is read from
//                    Shopify and must pass judgeExchangeOrder (its
//                    sourceIdentifier is this op's id, its lines the frozen
//                    ones), and its real line ids and funding are recorded
//                    with the done state;
//   release_hold   — the draft must read as gone, and the order's pointer to
//                    it is cleared with the done state.
//
// Reads only. NOT "use server"; imports nothing that can move money.
import { judgeDraftOrderGone, judgeExchangeOrder } from "./evidence";
import { recordDone, recordRejected, type DoneExtras } from "./ledger";
import { DRAFT_ORDER_QUERY, ORDER_BY_ID_QUERY, read } from "./reads";
import type { Operation } from "./types";

export type OperatorDecision = {
  verdict: "done" | "rejected";
  evidence: string;
  by: string;
  /** exchange_order + done: the gid of the order the operator found. */
  orderGid?: string;
};

export type OperatorOutcome =
  | { ok: true; written: boolean; summary: string }
  | { ok: false; reason: string };

const UNRESOLVED = { state: "unresolved" as const };

/** What a `done` would record, read and judged from Shopify. */
async function doneRecords(
  op: Operation,
  decision: OperatorDecision
): Promise<{ ok: true; effectRef: string; extras: DoneExtras } | { ok: false; reason: string }> {
  const request = op.request;
  if (request.kind === "exchange_order") {
    if (!decision.orderGid) return { ok: false, reason: "exchange_order needs --order <gid of the order you found>" };
    const r = await read(ORDER_BY_ID_QUERY, { id: decision.orderGid }, (d) => d?.order ?? null);
    if (!r.ok) return { ok: false, reason: `Shopify unreadable: ${r.error}` };
    const verdict = judgeExchangeOrder(request, r.value);
    if (verdict.v !== "done" || !verdict.lines) {
      return { ok: false, reason: `order ${decision.orderGid} is not this operation's order: ${JSON.stringify(verdict)}` };
    }
    return {
      ok: true,
      effectRef: verdict.effectRef,
      extras: {
        replacementLines: {
          orderId: verdict.effectRef.replace(/^gid:\/\/shopify\/Order\//, ""),
          lines: verdict.lines,
        },
        resolvedBy: decision.by,
      },
    };
  }
  if (request.kind === "release_hold") {
    const r = await read(DRAFT_ORDER_QUERY, { id: request.check.draftOrderId }, (d) => d?.draftOrder ?? null);
    if (!r.ok) return { ok: false, reason: `Shopify unreadable: ${r.error}` };
    const verdict = judgeDraftOrderGone(request, r.value);
    if (verdict.v !== "done") return { ok: false, reason: `draft ${request.check.draftOrderId} still exists` };
    return {
      ok: true,
      effectRef: verdict.effectRef,
      extras: {
        clearReservation: { orderId: request.check.orderId, draftOrderId: request.check.draftOrderId },
        resolvedBy: decision.by,
      },
    };
  }
  return { ok: true, effectRef: decision.evidence, extras: { resolvedBy: decision.by } };
}

export async function resolveOperation(
  op: Operation,
  decision: OperatorDecision,
  options: { write: boolean }
): Promise<OperatorOutcome> {
  if (op.state !== "unresolved") return { ok: false, reason: `not unresolved (${op.state})` };
  if (decision.verdict === "rejected") {
    if (!options.write) return { ok: true, written: false, summary: "would mark rejected" };
    const changed = await recordRejected(op, UNRESOLVED, decision.evidence, decision.by);
    return changed
      ? { ok: true, written: true, summary: "marked rejected" }
      : { ok: false, reason: "the operation is no longer unresolved" };
  }
  const records = await doneRecords(op, decision);
  if (!records.ok) return records;
  const summary = `done as ${records.effectRef}${
    records.extras.replacementLines ? `, ${records.extras.replacementLines.lines.length} replacement line(s)` : ""
  }${records.extras.clearReservation ? ", reservation pointer cleared" : ""}`;
  if (!options.write) return { ok: true, written: false, summary: `would mark ${summary}` };
  const { done } = await recordDone(
    op,
    UNRESOLVED,
    records.effectRef,
    { operator: decision.by, evidence: decision.evidence },
    records.extras
  );
  return done
    ? { ok: true, written: true, summary: `marked ${summary}` }
    : { ok: false, reason: "the operation is no longer unresolved" };
}
