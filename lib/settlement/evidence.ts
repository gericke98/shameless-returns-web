// What counts as DONE, per kind (S2 plan L5) — pure judges over what Shopify
// returned, whether that is the mutation's own answer or a later evidence read.
// One predicate per kind, applied to both, so an answer and a re-read can
// never disagree about the same facts.
//
// Pure: no db, no network.
import type { FrozenMoney, Operation, OpRequest } from "./types";
import { SOURCE_LINE_PROPERTY } from "./types";

export type Verdict =
  /** The effect provably happened and matches what was frozen. */
  | { v: "done"; effectRef: string; evidence: unknown }
  /** Shopify said no: the effect provably did NOT happen. */
  | { v: "rejected"; error: string }
  /** Shopify says the effect is absent. May be re-sent where the kind allows. */
  | { v: "absent"; detail: string }
  /** Something exists that does not match, or it failed: only a human decides. */
  | { v: "unresolved"; error: string }
  /** No verdict yet (pending, page truncated, GraphQL errors): look again later. */
  | { v: "wait"; reason: string };

const cents = (amount: unknown) => Math.round(Number(amount) * 100);

function sameMoney(
  money: { amount?: unknown; currencyCode?: unknown } | null | undefined,
  frozen: FrozenMoney
): boolean {
  return (
    !!money &&
    Number.isFinite(Number(money.amount)) &&
    cents(money.amount) === cents(frozen.amount) &&
    String(money.currencyCode) === frozen.currencyCode
  );
}

/** A refund transaction that pays exactly the frozen money against the frozen parent. */
type RefundTx = {
  kind?: string;
  status?: string;
  amountSet?: { presentmentMoney?: { amount?: string; currencyCode?: string } };
  parentTransaction?: { id?: string } | null;
};

function matchingTransactions(txs: RefundTx[], parentId: string, money: FrozenMoney) {
  return txs.filter(
    (tx) =>
      tx?.kind === "REFUND" &&
      tx?.parentTransaction?.id === parentId &&
      sameMoney(tx?.amountSet?.presentmentMoney, money)
  );
}

/** Judge the money half: one refund carrying one matching transaction. */
function judgeRefundMoney(
  refunds: Array<{ id: string; transactions?: any }>,
  parentId: string,
  money: FrozenMoney
): Verdict | { v: "ok"; refundId: string } {
  const hits: Array<{ refundId: string; tx: RefundTx }> = [];
  for (const refund of refunds) {
    const conn = refund?.transactions;
    if (conn?.pageInfo?.hasNextPage) return { v: "wait", reason: "refund transactions truncated" };
    for (const tx of matchingTransactions(conn?.nodes ?? [], parentId, money)) {
      hits.push({ refundId: refund.id, tx });
    }
  }
  if (hits.length === 0) return { v: "absent", detail: "no matching refund transaction" };
  if (hits.length > 1) return { v: "unresolved", error: `${hits.length} matching refund transactions` };
  const status = String(hits[0].tx.status ?? "");
  if (status === "SUCCESS") return { v: "ok", refundId: hits[0].refundId };
  if (status === "PENDING" || status === "AWAITING_RESPONSE") {
    return { v: "wait", reason: `refund transaction ${status}` };
  }
  return { v: "unresolved", error: `refund transaction ${status || "(no status)"}` };
}

/**
 * process_goods / process_refund, over a Return object (the returnProcess
 * answer or an evidence read). Goods: the return line is processed to the
 * frozen quantity AND the frozen reverse-fulfillment line carries NOT_RESTOCKED
 * dispositions of that quantity. Money (process_refund): exactly one refund
 * transaction, REFUND, SUCCESS, against the frozen parent, for the frozen
 * amount and currency.
 */
export function judgeReturn(
  request: Extract<OpRequest, { kind: "process_goods" | "process_refund" }>,
  ret: any
): Verdict {
  if (!ret) return { v: "absent", detail: "return not found" };
  const { check } = request;
  const rli = ret.returnLineItems;
  const rfos = ret.reverseFulfillmentOrders;
  if (rli?.pageInfo?.hasNextPage || rfos?.pageInfo?.hasNextPage) {
    return { v: "wait", reason: "return page truncated" };
  }
  const line = (rli?.nodes ?? []).find((n: any) => n?.id === check.returnLineItemId);
  if (!line) return { v: "unresolved", error: `return line ${check.returnLineItemId} missing` };

  let notRestocked = 0;
  let found = false;
  for (const rfo of rfos?.nodes ?? []) {
    if (rfo?.lineItems?.pageInfo?.hasNextPage) return { v: "wait", reason: "rfo page truncated" };
    for (const item of rfo?.lineItems?.nodes ?? []) {
      if (item?.id !== check.reverseFulfillmentLineItemId) continue;
      found = true;
      for (const d of item.dispositions ?? []) {
        if (d?.type === "NOT_RESTOCKED") notRestocked += Number(d.quantity) || 0;
      }
    }
  }
  if (!found) {
    return { v: "unresolved", error: `reverse fulfillment line ${check.reverseFulfillmentLineItemId} missing` };
  }

  const processed = Number(line.processedQuantity) || 0;
  const goodsDone = processed >= check.quantity && notRestocked >= check.quantity;
  const goodsUntouched = processed < check.quantity && notRestocked === 0;

  if (request.kind === "process_goods") {
    if (goodsDone) return { v: "done", effectRef: String(ret.id), evidence: { processed, notRestocked } };
    if (goodsUntouched) return { v: "absent", detail: `processed ${processed} of ${check.quantity}` };
    return {
      v: "unresolved",
      error: `return line processed ${processed}, NOT_RESTOCKED ${notRestocked}, frozen ${check.quantity}`,
    };
  }

  const refunds = ret.refunds;
  if (refunds?.pageInfo?.hasNextPage) return { v: "wait", reason: "return refunds truncated" };
  const money = judgeRefundMoney(
    refunds?.nodes ?? [],
    check.refund!.parentTransactionId,
    check.refund!.money
  );
  if (money.v === "wait" || money.v === "unresolved") return money;
  if (money.v === "ok" && goodsDone) {
    return { v: "done", effectRef: money.refundId, evidence: { processed, notRestocked, refund: money.refundId } };
  }
  if (money.v === "absent" && goodsUntouched) return { v: "absent", detail: "neither goods nor money" };
  // Goods without money, or money without goods: one mutation cannot do half,
  // so something else touched this return.
  return {
    v: "unresolved",
    error: `goods ${goodsDone ? "processed" : "unprocessed"} but money ${money.v === "ok" ? "present" : "absent"}`,
  };
}

/** The refundCreate answer's own refund. */
export function judgeRootRefund(
  request: Extract<OpRequest, { kind: "root_refund" }>,
  refund: any
): Verdict {
  if (!refund) return { v: "absent", detail: "no refund" };
  const money = judgeRefundMoney([refund], request.check.parentTransactionId, request.check.money);
  // A refund that exists but does not pay the frozen money is not "absent":
  // something moved, so only a human decides — never a re-send.
  if (money.v === "absent") return { v: "unresolved", error: `refund ${refund.id} does not match the frozen transaction` };
  if (money.v !== "ok") return money;
  if (!String(refund.note ?? "").includes(request.check.marker)) {
    return { v: "unresolved", error: `refund ${refund.id} does not carry ${request.check.marker}` };
  }
  return { v: "done", effectRef: String(refund.id), evidence: { refund: refund.id } };
}

/** A root order's refunds, searched for the op's note marker. */
export function judgeRootRefundsOnOrder(
  request: Extract<OpRequest, { kind: "root_refund" }>,
  refunds: any[] | null | undefined,
  pageSize: number
): Verdict {
  if (!Array.isArray(refunds)) return { v: "wait", reason: "order unreadable" };
  if (refunds.length >= pageSize) return { v: "wait", reason: "order refunds truncated" };
  const marked = refunds.filter((r) => String(r?.note ?? "").includes(request.check.marker));
  if (marked.length === 0) return { v: "absent", detail: `no refund carries ${request.check.marker}` };
  if (marked.length > 1) return { v: "unresolved", error: `${marked.length} refunds carry ${request.check.marker}` };
  return judgeRootRefund(request, marked[0]);
}

/** One gift card, matching every frozen fact. */
export function judgeGiftCard(
  request: Extract<OpRequest, { kind: "gift_card" }>,
  card: any
): Verdict {
  const { check } = request;
  const problems: string[] = [];
  if (card?.customer?.id !== check.customerGid) problems.push("customer");
  if (!sameMoney(card?.initialValue, check.money)) problems.push("initialValue");
  if (String(card?.lastCharacters ?? "").toUpperCase() !== check.code.slice(-4).toUpperCase()) {
    problems.push("lastCharacters");
  }
  if (!String(card?.note ?? "").includes(check.noteMarker)) problems.push("note");
  if (problems.length) return { v: "unresolved", error: `gift card ${card?.id} differs: ${problems.join(",")}` };
  return { v: "done", effectRef: String(card.id), evidence: { giftCard: card.id } };
}

export function judgeGiftCardSearch(
  request: Extract<OpRequest, { kind: "gift_card" }>,
  nodes: any[] | null | undefined
): Verdict {
  const cards = nodes ?? [];
  if (cards.length !== 1) {
    return { v: "unresolved", error: `gift card search for the frozen code found ${cards.length}` };
  }
  return judgeGiftCard(request, cards[0]);
}

/** The replacement lines an exchange order carries, read from the order itself. */
export type CreatedReplacementLine = {
  sourceProductsorderId: number;
  lineItemId: string;
  variantGid: string;
  quantity: number;
  stripeFundedCents: number;
};

/**
 * The exchange order: its sourceIdentifier is the op id, its customer the
 * frozen one, and its lines exactly the frozen (source line, variant,
 * quantity) set — matched by the source-line property, never by variant.
 */
export function judgeExchangeOrder(
  request: Extract<OpRequest, { kind: "exchange_order" }>,
  order: any
): Verdict & { lines?: CreatedReplacementLine[] } {
  const { check } = request;
  if (!order) return { v: "absent", detail: "no order" };
  if (order.sourceIdentifier !== check.sourceIdentifier) {
    return { v: "unresolved", error: `order ${order.id} sourceIdentifier ${order.sourceIdentifier}` };
  }
  if ((order.customer?.id ?? null) !== check.customerGid) {
    return { v: "unresolved", error: `order ${order.id} customer ${order.customer?.id ?? "(none)"}` };
  }
  if (order.lineItems?.pageInfo?.hasNextPage) return { v: "wait", reason: "order lines truncated" };
  const nodes: any[] = order.lineItems?.nodes ?? [];
  const bySource = new Map<number, any>();
  for (const node of nodes) {
    const attr = (node?.customAttributes ?? []).find((a: any) => a?.key === SOURCE_LINE_PROPERTY);
    const source = Number(attr?.value);
    if (!Number.isInteger(source) || bySource.has(source)) {
      return { v: "unresolved", error: `order ${order.id} line ${node?.id} has no unique source line` };
    }
    bySource.set(source, node);
  }
  if (bySource.size !== check.lines.length) {
    return { v: "unresolved", error: `order ${order.id} has ${bySource.size} lines, frozen ${check.lines.length}` };
  }
  const lines: CreatedReplacementLine[] = [];
  for (const frozen of check.lines) {
    const node = bySource.get(frozen.sourceProductsorderId);
    if (!node || node.variant?.id !== frozen.variantGid || Number(node.quantity) !== frozen.quantity) {
      return { v: "unresolved", error: `order ${order.id} line for source ${frozen.sourceProductsorderId} differs` };
    }
    lines.push({
      sourceProductsorderId: frozen.sourceProductsorderId,
      lineItemId: String(node.id),
      variantGid: frozen.variantGid,
      quantity: frozen.quantity,
      stripeFundedCents: frozen.stripeFundedCents,
    });
  }
  return { v: "done", effectRef: String(order.id), evidence: { order: order.id, name: order.name }, lines };
}

export function judgeExchangeOrderSearch(
  request: Extract<OpRequest, { kind: "exchange_order" }>,
  nodes: any[] | null | undefined
): Verdict & { lines?: CreatedReplacementLine[] } {
  const orders = nodes ?? [];
  // A negative search never authorises a resend: zero is unresolved.
  if (orders.length !== 1) {
    return { v: "unresolved", error: `exchange order search for the op id found ${orders.length}` };
  }
  return judgeExchangeOrder(request, orders[0]);
}

export function judgeDraftOrderGone(
  request: Extract<OpRequest, { kind: "release_hold" }>,
  draft: any
): Verdict {
  if (draft) return { v: "absent", detail: `draft ${request.check.draftOrderId} still exists` };
  return { v: "done", effectRef: request.check.draftOrderId, evidence: { deleted: request.check.draftOrderId } };
}

/** userErrors as one string, or null when there are none. */
export function userErrorsOf(payload: any): string | null {
  const errors = payload?.userErrors;
  return Array.isArray(errors) && errors.length > 0 ? JSON.stringify(errors).slice(0, 2000) : null;
}

export type { Operation };
