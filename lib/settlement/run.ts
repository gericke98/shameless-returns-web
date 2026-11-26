// L4/L5 — executing one operation: claim → dispatch → send → record, and
// recovery's handling of an operation nobody heard back from.
//
// NOT "use server". Reached only from settleSubmission (dashboard,
// auto-approve) and the recovery cron.
import { randomUUID } from "node:crypto";
import { send } from "./effects";
import {
  judgeDraftOrderGone,
  judgeExchangeOrder,
  judgeExchangeOrderSearch,
  judgeGiftCard,
  judgeGiftCardSearch,
  judgeReturn,
  judgeRootRefund,
  judgeRootRefundsOnOrder,
  userErrorsOf,
  type CreatedReplacementLine,
  type Verdict,
} from "./evidence";
import {
  claim,
  dispatch,
  loadSubmission,
  recordDone,
  recordRejected,
  recordUnresolved,
  returnClaimForStock,
  takeOver,
  type DoneExtras,
  type Fence,
} from "./ledger";
import { exchangeCoverage } from "./stockGate";
import {
  DRAFT_ORDER_QUERY,
  GIFT_CARD_SEARCH_QUERY,
  ORDER_REFUNDS_PAGE,
  ORDER_REFUNDS_QUERY,
  ORDER_SEARCH_QUERY,
  REFUND_BY_ID_QUERY,
  RETURN_EVIDENCE_QUERY,
  read,
} from "./reads";
import { graphQLErrors } from "./shopify";
import { ROOT_REFUND_REPLAY_HOURS, type Operation } from "./types";
import type { WriteCapability } from "@/lib/server/identity";

export type RunResult =
  | "done"
  | "rejected"
  | "unresolved"
  /** Sent, no verdict yet: stays dispatched for recovery. */
  | "in-flight"
  /** Someone else holds it, its dependency is not done, or it is not claimable. */
  | "not-claimed"
  /** A1: Amphora is short for a fresh orderCreate — not sent; a hold now blocks the submission. */
  | "held"
  /** A1: Amphora is unreadable — not sent, back to pending for the next run. */
  | "wait";

type Judged = Verdict & { lines?: CreatedReplacementLine[] };

/** The worker fence for recording on a row in the state we observed it in. */
function fenceOf(op: Operation): Fence {
  if (op.state !== "dispatched" && op.state !== "claimed") {
    throw new Error(`fenceOf: op ${op.id} is ${op.state}, not a worker-held state`);
  }
  return { state: op.state, owner: op.owner, leaseGen: op.leaseGen };
}

/** Run one operation from the top. */
export async function run(cap: WriteCapability, opId: string, me: string = randomUUID()): Promise<RunResult> {
  const claimed = await claim(cap, opId, me);
  if (!claimed) return "not-claimed";
  if (claimed.kind === "exchange_order") {
    const authorized = await authorizeExchangeSend(cap, claimed, me);
    if (authorized !== "covered") return authorized;
  }
  return dispatchAndSend(cap, claimed, me);
}

/**
 * A1 (FX amendment): Amphora authorizes EVERY fresh orderCreate — a claim
 * from `pending` (first send, recovered after a crash) or from `rejected`
 * (after an operator's `--release`). `claim` never returns an op that has
 * dispatched, so a takeover of an unanswered send never reaches here: that
 * stays evidence-only (`recoverDispatched`), never a fresh order.
 *
 * Demand is the FROZEN request's lines — never re-derived from rows — and
 * `earlier` is the open demand of submissions accepted at or before this one.
 */
async function authorizeExchangeSend(
  cap: WriteCapability,
  op: Operation,
  me: string
): Promise<"covered" | "held" | "wait" | "not-claimed"> {
  const request = op.request;
  if (request.kind !== "exchange_order") return "covered";
  const loaded = await loadSubmission(op.submissionId);
  const coverage = loaded
    ? await exchangeCoverage(
        op.submissionId,
        request.check.lines.map((l) => ({ variantGid: l.variantGid, quantity: l.quantity }))
      )
    : ({ kind: "unreadable", reason: "no-submission" } as const);
  if (coverage.kind === "covered") return "covered";
  if (coverage.kind === "unreadable") {
    return (await returnClaimForStock(cap, op, me, null)) ? "wait" : "not-claimed";
  }
  const held = await returnClaimForStock(cap, op, me, {
    seenSeq: loaded!.submission.admissionSeq,
    short: coverage.short,
  });
  return held ? "held" : "not-claimed";
}

async function dispatchAndSend(cap: WriteCapability, claimed: Operation, me: string): Promise<RunResult> {
  const token = await dispatch(cap, claimed, me);
  if (!token) return "not-claimed";
  const answer = await send(token, token);
  if (answer.kind === "no-answer") return "in-flight";
  const verdict = await judgeAnswer(token, answer.body);
  return apply(cap, token, fenceOf(token), verdict);
}

/** Judge what the mutation itself answered. */
async function judgeAnswer(op: Operation, body: any): Promise<Judged> {
  if (graphQLErrors(body)) return { v: "wait", reason: graphQLErrors(body)! };
  const request = op.request;
  switch (request.kind) {
    case "process_goods":
    case "process_refund": {
      const payload = body?.data?.returnProcess;
      const errors = userErrorsOf(payload);
      if (errors) return { v: "rejected", error: errors };
      const verdict = judgeReturn(request, payload?.return);
      // Shopify accepted the mutation: an "absent" effect is not a refusal.
      return verdict.v === "absent" ? { v: "unresolved", error: verdict.detail } : verdict;
    }
    case "root_refund": {
      const payload = body?.data?.refundCreate;
      const errors = userErrorsOf(payload);
      if (errors) return { v: "rejected", error: errors };
      const verdict = judgeRootRefund(request, payload?.refund);
      return verdict.v === "absent" ? { v: "unresolved", error: verdict.detail } : verdict;
    }
    case "gift_card": {
      const payload = body?.data?.giftCardCreate;
      const errors: any[] = payload?.userErrors ?? [];
      // The code is ours and unique per shop: TAKEN means this card exists.
      // Prove it is the one we froze.
      if (errors.some((e) => e?.code === "TAKEN")) return readEvidence(op);
      if (errors.length) return { v: "rejected", error: JSON.stringify(errors).slice(0, 2000) };
      if (!payload?.giftCard) return { v: "unresolved", error: "giftCardCreate answered without a card" };
      return judgeGiftCard(request, payload.giftCard);
    }
    case "exchange_order": {
      const payload = body?.data?.orderCreate;
      const errors = userErrorsOf(payload);
      if (errors) return { v: "rejected", error: errors };
      const verdict = judgeExchangeOrder(request, payload?.order);
      return verdict.v === "absent" ? { v: "unresolved", error: verdict.detail } : verdict;
    }
    case "release_hold": {
      const payload = body?.data?.draftOrderDelete;
      if (payload?.deletedId === request.check.draftOrderId) {
        return { v: "done", effectRef: request.check.draftOrderId, evidence: { deleted: payload.deletedId } };
      }
      // Refused — possibly because it is already gone. Shopify decides.
      const gone = await readEvidence(op);
      if (gone.v === "done") return gone;
      return { v: "rejected", error: userErrorsOf(payload) ?? "draftOrderDelete deleted nothing" };
    }
  }
}

/** Re-read what Shopify holds for this operation (L5 table, "done evidence"). */
export async function readEvidence(op: Operation): Promise<Judged> {
  const request = op.request;
  const wait = (error: string): Judged => ({ v: "wait", reason: error });
  switch (request.kind) {
    case "process_goods":
    case "process_refund": {
      const r = await read(RETURN_EVIDENCE_QUERY, { id: request.check.returnId }, (d) => d?.return ?? null);
      return r.ok ? judgeReturn(request, r.value) : wait(r.error);
    }
    case "root_refund": {
      // A known refund gid is re-read indefinitely: the 23 h limit is on replay, not observation.
      if (op.effectRef) {
        const r = await read(REFUND_BY_ID_QUERY, { id: op.effectRef }, (d) => d?.refund ?? null);
        return r.ok ? judgeRootRefund(request, r.value) : wait(r.error);
      }
      const r = await read(
        ORDER_REFUNDS_QUERY,
        { id: request.check.orderGid, first: ORDER_REFUNDS_PAGE },
        (d) => d?.order?.refunds ?? null
      );
      return r.ok ? judgeRootRefundsOnOrder(request, r.value, ORDER_REFUNDS_PAGE) : wait(r.error);
    }
    case "gift_card": {
      // Gift-card search has no `code:` field; the default term searches codes.
      const r = await read(GIFT_CARD_SEARCH_QUERY, { query: request.check.code }, (d) => d?.giftCards?.nodes ?? null);
      return r.ok ? judgeGiftCardSearch(request, r.value) : wait(r.error);
    }
    case "exchange_order": {
      const r = await read(
        ORDER_SEARCH_QUERY,
        { query: `source_identifier:${request.check.sourceIdentifier}` },
        (d) => d?.orders?.nodes ?? null
      );
      return r.ok ? judgeExchangeOrderSearch(request, r.value) : wait(r.error);
    }
    case "release_hold": {
      const r = await read(DRAFT_ORDER_QUERY, { id: request.check.draftOrderId }, (d) => d?.draftOrder ?? null);
      return r.ok ? judgeDraftOrderGone(request, r.value) : wait(r.error);
    }
  }
}

function doneExtras(op: Operation, verdict: Judged): DoneExtras {
  const request = op.request;
  if (request.kind === "exchange_order" && verdict.lines) {
    const orderId = String(verdict.v === "done" ? verdict.effectRef : "").replace(/^gid:\/\/shopify\/Order\//, "");
    return { replacementLines: { orderId, lines: verdict.lines } };
  }
  if (request.kind === "release_hold") {
    return { clearReservation: { orderId: request.check.orderId, draftOrderId: request.check.draftOrderId } };
  }
  return {};
}

function unresolvedAlert(op: Operation, error: string) {
  return {
    subject: `[returns] SETTLEMENT NEEDS A HUMAN — ${op.kind} ${op.id}`,
    body: [
      `Settlement operation ${op.id} (${op.kind}, ${op.scopeKey}) cannot be decided automatically.`,
      `Why: ${error}`,
      `Amount: ${(op.amountCents / 100).toFixed(2)} ${op.currency}. Attempt ${op.attempt}.`,
      `Check Shopify by hand, then record what you found:`,
      `  npx tsx scripts/resolve-operation.ts --op ${op.id} --done|--rejected --evidence "<gid / notes>" --write`,
      `Nothing will touch this operation until then.`,
    ].join("\n"),
  };
}

async function apply(cap: WriteCapability, op: Operation, fence: Fence, verdict: Judged): Promise<RunResult> {
  switch (verdict.v) {
    case "done":
      await recordDone(cap, op, fence, verdict.effectRef, verdict.evidence, doneExtras(op, verdict));
      return "done";
    case "rejected":
      await recordRejected(cap, op, fence, verdict.error);
      return "rejected";
    case "unresolved":
      await recordUnresolved(cap, op, fence, verdict.error, unresolvedAlert(op, verdict.error));
      return "unresolved";
    case "absent":
      // An answered mutation never lands here (judgeAnswer maps it); a re-read
      // does, and recovery decides what absence permits.
      return "in-flight";
    case "wait":
      return "in-flight";
  }
}

const hoursSince = (date: Date | null) =>
  date ? (Date.now() - date.getTime()) / 3_600_000 : Infinity;

/**
 * Recovery for an operation that has dispatched before and nobody heard back
 * from — dispatched over a lease ago, or a takeover claim whose lease ran out:
 * re-read the evidence, then follow the L5 table. Only a takeover row
 * authorises a re-send, and it keeps the op's attempt (its idempotency key)
 * and first-dispatch time.
 */
export async function recoverDispatched(cap: WriteCapability, op: Operation, me: string = randomUUID()): Promise<RunResult> {
  // A gift card is re-sent with its frozen code: the re-send IS the probe
  // (created, or TAKEN → evidence). Every other kind is read first.
  if (op.kind === "gift_card") return resend(cap, op, me);

  const verdict = await readEvidence(op);
  if (verdict.v !== "absent") return apply(cap, op, fenceOf(op), verdict);

  switch (op.kind) {
    case "exchange_order":
      // Unreachable (a zero search is already unresolved), and never re-sent.
      return apply(cap, op, fenceOf(op), { v: "unresolved", error: verdict.detail });
    case "root_refund":
      if (hoursSince(op.dispatchedAt) >= ROOT_REFUND_REPLAY_HOURS) {
        return apply(cap, op, fenceOf(op), {
          v: "unresolved",
          error: `no refund carries [${op.id}] ${ROOT_REFUND_REPLAY_HOURS} h after dispatch; its idempotency key has expired`,
        });
      }
      return resend(cap, op, me);
    default:
      return resend(cap, op, me);
  }
}

async function resend(cap: WriteCapability, op: Operation, me: string): Promise<RunResult> {
  const taken = await takeOver(cap, op, me);
  if (!taken) return "not-claimed";
  return dispatchAndSend(cap, taken, me);
}
