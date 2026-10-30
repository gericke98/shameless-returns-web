// S3 R1 — the legacy reconciliation classifier. Pure: no db, no network.
//
// docs/superpowers/specs/2026-10-30-settlement-S3-legacy-plan.md
//
// For every settled line the ledger has never touched, EVERY effect the
// pre-ledger writers could have left for it is read, whatever its action —
// the old writer chose by `credit` before `action`, so the action alone never
// says which writer ran:
//
//   money     refunds on the line's Shopify return; for a line on one of our
//             replacement orders, refunds on the ROOT order; the gift card in
//             `gift_card_id`;
//   delivery  exactly one order tagged `Change` + `Order <number>` whose lines
//             contain the new variant, or the return's native exchange line.
//
// An effect belongs to a line only by explicit identity: a refund whose
// refundLineItems name the line's order line item, a root refund carrying the
// bracketed marker `[<return line item gid>]` the pre-S2 code wrote, an effect
// the ledger already recorded for the line, or a recorded human decision
// (reconciliation_effect_decisions, drizzle/0011) that binds it. A refund
// that moved money and that no identity attributes to any line is NOT absence
// of payment: every line it could have paid is `ambiguous` until a human binds
// or excludes it by its stable id. Notes are never read for words.
//
// Amounts and currencies are checked only after identity matched. A line is
// `paid` (exactly the effect its writer leaves, verified), `unpaid` (a
// complete read found no effect, on a return that is open or closed),
// `ambiguous` (several or conflicting effects, an unattributed refund, an
// unreadable or truncated read, a recipient or currency that does not match),
// `null-action` (no lane: a human decides, D3) or `needs-human` (no Shopify
// return on the line: nothing to read, nothing any write path may record).
import { lineTotalCents } from "@/lib/basket";
import { returnOwnerProblem } from "./returnOwnership";
import { variantGid } from "@/lib/shopifyIds";

export type Lane = "refund" | "root_refund" | "credit" | "exchange";
export type ReconcileClass = "paid" | "unpaid" | "ambiguous" | "null-action" | "needs-human";

/** One productsorder row, as the reconciliation reads it. */
export type LineFacts = {
  productsorderId: number;
  orderId: string;
  orderNumber: string;
  returnId: string | null;
  returnLineItemId: string | null;
  /** The order line item (bare id or gid). */
  lineItemId: string;
  action: string | null;
  newVariantId: string | null;
  credit: boolean;
  refunded: boolean;
  price: string;
  quantity: number;
  giftCardId: string | null;
  /** The order is one of our replacement orders (`orders.exchange_of`). */
  isReplacement: boolean;
};

type Tx = {
  kind?: string;
  status?: string;
  amountSet?: { presentmentMoney?: { amount?: string; currencyCode?: string } };
};
type TxConn = { pageInfo?: { hasNextPage?: boolean }; nodes?: Tx[] };

/** What `ReconcileReturn` answers (lib/settlement/reconcileReads.ts). */
export type ReturnEvidence = {
  id: string;
  status: string;
  order: { id: string; name?: string; presentmentCurrencyCode?: string; customer?: { id?: string } | null } | null;
  exchangeLineItems?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: Array<{ id: string; lineItems?: Array<{ id?: string; variant?: { id?: string } | null }> | null }>;
  };
  refunds?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: Array<{
      id: string;
      refundLineItems?: { pageInfo?: { hasNextPage?: boolean }; nodes?: Array<{ lineItem?: { id?: string } }> };
      transactions?: TxConn;
    }>;
  };
};

export type RootRefundsEvidence = {
  orderGid: string;
  presentmentCurrencyCode: string | null;
  /** Null when the page was full (more refunds than one read returns). */
  refunds: Array<{ id: string; note?: string | null; transactions?: TxConn }> | null;
};

export type GiftCardEvidence = {
  id: string;
  initialValue?: { amount?: string; currencyCode?: string } | null;
  customer?: { id?: string } | null;
} | null;

export type ExchangeOrderEvidence = {
  id: string;
  name?: string;
  tags?: string[];
  customer?: { id?: string } | null;
  lineItems?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: Array<{
      id: string;
      quantity?: number;
      variant?: { id?: string } | null;
      originalUnitPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } } | null;
    }>;
  };
};

/** A read that answered, or why it gave no verdict. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** Everything read for one line (readsNeeded says which are required). */
export type LineReads = {
  ret: Read<ReturnEvidence | null>;
  /** Required for a line on a replacement order. */
  rootRefunds?: Read<RootRefundsEvidence>;
  /** Required when the row stores a gift card. */
  giftCard?: Read<GiftCardEvidence>;
  /** Required when the row names a new variant: orders the tag search returned. */
  exchangeOrders?: Read<{ truncated: boolean; nodes: ExchangeOrderEvidence[] }>;
};

export type PaidEvidence =
  | { lane: "refund"; refundId: string; amountCents: number; currency: string }
  | { lane: "root_refund"; refundId: string; amountCents: number; currency: string; rootOrderGid: string }
  | { lane: "credit"; giftCardId: string; amountCents: number; currency: string }
  | {
      lane: "exchange";
      orderGid: string;
      orderName: string;
      lineItemId: string;
      variantGid: string;
      quantity: number;
      unitCents: number;
      currency: string;
    }
  | { lane: "native_exchange"; returnGid: string; exchangeLineItemId: string; variantGid: string };

export type Classification = {
  productsorderId: number;
  lane: Lane | null;
  cls: ReconcileClass;
  reason: string;
  returnStatus: string | null;
  evidence?: PaidEvidence;
  /** A delivered exchange: the money effects ALSO found for the line (a
   *  refund, a gift card). Any one means its difference was not left unpaid. */
  moneyEffects?: string[];
  /** Refunds that moved money and that no identity attributes to any line:
   *  only a recorded human decision (bind or exclude) clears them. */
  unattributed?: string[];
};

/** A human's recorded decision about one effect (drizzle/0011). */
export type EffectDecision = { verdict: "binds" | "excludes"; productsorderId: number | null };

/** Facts that decide identity, computed over the whole confirmed population
 *  and the ledger. */
export type SharedIdentity = {
  /** Gift card id → how many lines name it. */
  giftCardUses: Map<string, number>;
  /** `<order id>|<variant gid>` → how many confirmed CAMBIO lines of that order name it. */
  exchangeVariantUses: Map<string, number>;
  /** Every return line item gid a confirmed row names: the markers a root refund may carry. */
  markers: Set<string>;
  /** Effect id (refund / gift card gid) → the lines the ledger recorded it for. */
  recordedEffects: Map<string, number[]>;
  /** Effect id → a human's recorded decision. */
  decisions: Map<string, EffectDecision>;
};

const cents = (amount: unknown) => Math.round(Number(amount) * 100);
const lineItemGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/LineItem/${id}`);
const giftCardGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/GiftCard/${id}`);

/**
 * The lane the pre-ledger writer took for a row: `credit` first — it paid a
 * credit row by gift card whatever its action — then CAMBIO (an exchange
 * order), then a refund (on the root order for a replacement order's line).
 */
export function laneOf(line: Pick<LineFacts, "action" | "credit" | "isReplacement">): Lane | null {
  if (line.action !== "CAMBIO" && line.action !== "DEVOLUCIÓN") return null;
  if (line.credit) return "credit";
  if (line.action === "CAMBIO") return "exchange";
  return line.isReplacement ? "root_refund" : "refund";
}

/** Which reads a line needs: every source of an effect it could have. */
export function readsNeeded(line: Pick<LineFacts, "isReplacement" | "giftCardId" | "newVariantId" | "action">) {
  return {
    rootRefunds: line.isReplacement,
    giftCard: !!line.giftCardId,
    exchangeOrders: line.action === "CAMBIO" || !!variantGid(line.newVariantId),
  };
}

export const exchangeVariantKey = (orderId: string, newVariantId: string | null) =>
  `${orderId}|${variantGid(newVariantId) ?? ""}`;

export function sharedIdentity(
  lines: LineFacts[],
  ledger: { recordedEffects?: Map<string, number[]>; decisions?: Map<string, EffectDecision> } = {}
): SharedIdentity {
  const giftCardUses = new Map<string, number>();
  const exchangeVariantUses = new Map<string, number>();
  const markers = new Set<string>();
  for (const l of lines) {
    if (l.giftCardId) {
      const k = giftCardGid(l.giftCardId);
      giftCardUses.set(k, (giftCardUses.get(k) ?? 0) + 1);
    }
    if (l.action === "CAMBIO" && l.newVariantId) {
      const k = exchangeVariantKey(l.orderId, l.newVariantId);
      exchangeVariantUses.set(k, (exchangeVariantUses.get(k) ?? 0) + 1);
    }
    if (l.returnLineItemId) markers.add(l.returnLineItemId);
  }
  return {
    giftCardUses,
    exchangeVariantUses,
    markers,
    recordedEffects: ledger.recordedEffects ?? new Map(),
    decisions: ledger.decisions ?? new Map(),
  };
}

/**
 * Group lines by explicit identity: one order, one Shopify return and one
 * tender is one historical submission. The order is part of the key because a
 * legacy return_id was stamped across orders (lib/settlement/returnOwnership);
 * a line whose return is another order's never reaches a group that records —
 * classifyLine makes it needs-human, and `returnOwnedRead` gates the write.
 */
export function groupKey(line: Pick<LineFacts, "orderId" | "returnId" | "credit">): string {
  return `${line.orderId}|${line.returnId ?? "(none)"}|${line.credit ? "credit" : "refund"}`;
}

/**
 * R1 records a line only on a return Shopify READ and confirmed is the line's
 * own order's: an unreadable or missing return proves no ownership, so its
 * return_id is not identity yet (the next run reads it again).
 */
export function returnOwnedRead(line: Pick<LineFacts, "orderId">, ret: Read<ReturnEvidence | null>): boolean {
  return ret.ok && !!ret.value && returnOwnerProblem(line.orderId, ret.value.order?.id) === null;
}

const PROCESSED_OR_OPEN = new Set(["OPEN", "CLOSED"]);

type MoneyVerdict =
  | { v: "paid"; refundId: string; amountCents: number; currency: string }
  | { v: "none" }
  | { v: "ambiguous"; reason: string };

/** Did this refund move (or is it moving) money? A zero-transaction refund —
 *  how the old credit writer booked goods — moved none. */
function movesMoney(refund: { transactions?: TxConn }): boolean {
  if (refund.transactions?.pageInfo?.hasNextPage) return true;
  return (refund.transactions?.nodes ?? []).some(
    (t) => t?.kind === "REFUND" && (t.status === "SUCCESS" || t.status === "PENDING" || t.status === "AWAITING_RESPONSE")
  );
}

/** Over refunds already known to be the line's own: the money they moved. */
function judgeOwnRefunds(
  own: Array<{ id: string; transactions?: TxConn }>,
  expectedCurrency: string | null | undefined
): MoneyVerdict {
  const paying: Array<{ id: string; txs: Tx[] }> = [];
  for (const refund of own) {
    const conn = refund.transactions;
    if (conn?.pageInfo?.hasNextPage) return { v: "ambiguous", reason: `refund ${refund.id} transactions truncated` };
    const txs = (conn?.nodes ?? []).filter((t) => t?.kind === "REFUND");
    if (txs.some((t) => t.status === "PENDING" || t.status === "AWAITING_RESPONSE")) {
      return { v: "ambiguous", reason: `refund ${refund.id} transaction pending` };
    }
    const ok = txs.filter((t) => t.status === "SUCCESS");
    if (ok.length > 0) paying.push({ id: refund.id, txs: ok });
  }
  if (paying.length === 0) return { v: "none" };
  if (paying.length > 1) return { v: "ambiguous", reason: `${paying.length} refunds paid this line` };
  const [hit] = paying;
  const currencies = new Set(hit.txs.map((t) => String(t.amountSet?.presentmentMoney?.currencyCode ?? "")));
  const currency = Array.from(currencies)[0];
  if (currencies.size !== 1 || !expectedCurrency || currency !== expectedCurrency) {
    return {
      v: "ambiguous",
      reason: `refund ${hit.id} currency ${Array.from(currencies).join("/")} vs order ${expectedCurrency ?? "(unknown)"}`,
    };
  }
  const amountCents = hit.txs.reduce((s, t) => s + cents(t.amountSet?.presentmentMoney?.amount), 0);
  return { v: "paid", refundId: hit.id, amountCents, currency };
}

/**
 * Whose is this money-moving refund, for `line`? A human's decision first,
 * then the ledger's records, then the identity the refund itself carries.
 * `null` = no identity attributes it to any line.
 */
function ownerOf(
  refundId: string,
  carried: "mine" | "other" | "none",
  line: LineFacts,
  shared: SharedIdentity
): "mine" | "other" | "excluded" | null {
  const d = shared.decisions.get(refundId);
  if (d) {
    if (d.verdict === "excludes") return "excluded";
    return d.productsorderId === line.productsorderId ? "mine" : "other";
  }
  const recorded = shared.recordedEffects.get(refundId);
  if (recorded) return recorded.includes(line.productsorderId) ? "mine" : "other";
  if (carried === "mine") return "mine";
  if (carried === "other") return "other";
  return null;
}

export function classifyLine(line: LineFacts, reads: LineReads, shared: SharedIdentity): Classification {
  const lane = laneOf(line);
  const base = { productsorderId: line.productsorderId, lane };
  const ret = reads.ret.ok ? reads.ret.value : null;
  const returnStatus = ret?.status ?? null;
  const out = (cls: ReconcileClass, reason: string, extra: Partial<Classification> = {}): Classification => ({
    ...base,
    cls,
    reason,
    returnStatus,
    ...extra,
  });
  const ambiguous = (reason: string, extra: Partial<Classification> = {}) => out("ambiguous", reason, extra);
  /** No effect after a complete read: unpaid, but only for a return that is open or processed. */
  const none = (reason: string) =>
    PROCESSED_OR_OPEN.has(String(returnStatus)) ? out("unpaid", reason) : ambiguous(`${reason}; return ${returnStatus}`);

  // No Shopify return: no identity to read evidence by, and no return line a
  // submission could name. Listed for a human — whatever its action — and no
  // write path takes it (not R1's record, an approval, D3, nor admission).
  if (!line.returnId || !line.returnLineItemId) return out("needs-human", "no Shopify return on the line");
  // The return Shopify read belongs to another order: this row's return_id was
  // stamped across orders, so it identifies nothing here. Never grouped,
  // never recorded — a human decides what this row's return is.
  if (ret && returnOwnerProblem(line.orderId, ret.order?.id)) {
    return out("needs-human", `return id belongs to order ${ret.order?.name ?? ret.order?.id ?? "(none)"} (${ret.order?.id ?? "no order"})`);
  }
  if (!lane) return out("null-action", "action is NULL");
  if (!reads.ret.ok) return ambiguous(`return unreadable: ${reads.ret.error}`);
  if (!ret) return ambiguous(`return ${line.returnId} not found`);

  const problems: string[] = [];
  const unattributed: string[] = [];
  const need = readsNeeded(line);

  // ── Refunds on the return ────────────────────────────────────────────────
  const gid = lineItemGid(line.lineItemId);
  const ownReturn: Array<{ id: string; transactions?: TxConn }> = [];
  if (ret.refunds?.pageInfo?.hasNextPage) problems.push("return refunds truncated");
  for (const r of ret.refunds?.nodes ?? []) {
    if (r.refundLineItems?.pageInfo?.hasNextPage) {
      problems.push(`refund ${r.id} line items truncated`);
      continue;
    }
    const named = (r.refundLineItems?.nodes ?? []).map((n) => n?.lineItem?.id).filter(Boolean) as string[];
    const carried = named.includes(gid) ? "mine" : named.length > 0 ? "other" : "none";
    if (!movesMoney(r)) continue;
    const owner = ownerOf(r.id, carried, line, shared);
    if (owner === "mine") ownReturn.push(r);
    else if (owner === null) unattributed.push(r.id);
  }

  // ── Refunds on the root order (a replacement order's line) ───────────────
  const ownRoot: Array<{ id: string; transactions?: TxConn }> = [];
  let root: RootRefundsEvidence | null = null;
  if (need.rootRefunds) {
    const r = reads.rootRefunds;
    if (!r) problems.push("root order not read");
    else if (!r.ok) problems.push(`root order unreadable: ${r.error}`);
    else if (!r.value.refunds) problems.push("root order refunds truncated");
    else {
      root = r.value;
      const mine = `[${line.returnLineItemId}]`;
      for (const x of r.value.refunds) {
        if (!movesMoney(x)) continue;
        const note = String(x.note ?? "");
        const carried = note.includes(mine)
          ? "mine"
          : Array.from(shared.markers).some((m) => m !== line.returnLineItemId && note.includes(`[${m}]`))
            ? "other"
            : "none";
        const owner = ownerOf(x.id, carried, line, shared);
        if (owner === "mine") ownRoot.push(x);
        else if (owner === null) unattributed.push(x.id);
      }
    }
  }

  // ── The stored gift card ─────────────────────────────────────────────────
  let card: PaidEvidence | null = null;
  if (line.giftCardId) {
    const cardGid = giftCardGid(line.giftCardId);
    const uses = shared.giftCardUses.get(cardGid) ?? 0;
    const g = reads.giftCard;
    if (uses > 1) problems.push(`gift card ${cardGid} is named by ${uses} lines`);
    else if (!g) problems.push("gift card not read");
    else if (!g.ok) problems.push(`gift card unreadable: ${g.error}`);
    else if (!g.value) problems.push(`gift card ${cardGid} not found`);
    else {
      const customer = ret.order?.customer?.id ?? null;
      const currency = String(g.value.initialValue?.currencyCode ?? "");
      if (!customer || g.value.customer?.id !== customer) {
        problems.push(`gift card ${cardGid} customer ${g.value.customer?.id ?? "(none)"} vs order ${customer ?? "(none)"}`);
      } else if (currency !== "EUR") problems.push(`gift card ${cardGid} currency ${currency || "(none)"}`);
      else card = { lane: "credit", giftCardId: g.value.id, amountCents: cents(g.value.initialValue?.amount), currency };
    }
  } else if (line.credit) {
    // The spec's fallback — search the customer's gift cards for one whose
    // note names the order — cannot be built: pre-S2 cards were created with
    // no note, and an amount is never identity.
    problems.push("credit row with no gift_card_id: no identity to look for its gift card");
  }

  // ── Delivery: an exchange order of ours, or a native exchange line ───────
  const deliveries: PaidEvidence[] = [];
  const variant = variantGid(line.newVariantId);
  if (line.action === "CAMBIO" && !variant) problems.push("exchange line has no new variant");
  if (variant) {
    const sharing = shared.exchangeVariantUses.get(exchangeVariantKey(line.orderId, line.newVariantId)) ?? 0;
    const e = reads.exchangeOrders;
    if (!e) problems.push("exchange orders not searched");
    else if (!e.ok) problems.push(`exchange order search unreadable: ${e.error}`);
    else if (e.value.truncated) problems.push("exchange order search truncated");
    else {
      const tag = `Order ${line.orderNumber}`;
      const candidates = [];
      for (const order of e.value.nodes) {
        const tags = order.tags ?? [];
        if (!tags.includes("Change") || !tags.includes(tag)) continue;
        if (order.lineItems?.pageInfo?.hasNextPage) {
          problems.push(`order ${order.id} lines truncated`);
          continue;
        }
        if ((order.lineItems?.nodes ?? []).some((n) => n.variant?.id === variant)) candidates.push(order);
      }
      if (candidates.length > 1) problems.push(`${candidates.length} exchange orders contain ${variant}`);
      else if (candidates.length === 1) {
        const judged = judgeLegacyExchangeOrder(
          { orderNumber: line.orderNumber, customerGid: ret.order?.customer?.id ?? null, newVariantGid: variant, quantity: line.quantity },
          candidates[0]
        );
        if (!judged.ok) problems.push(judged.reason);
        else
          deliveries.push({
            lane: "exchange",
            orderGid: judged.orderGid,
            orderName: judged.orderName,
            lineItemId: judged.lineItemId,
            variantGid: judged.variantGid,
            quantity: judged.quantity,
            unitCents: judged.unitCents,
            currency: "EUR",
          });
      }
    }
    const xli = ret.exchangeLineItems;
    if (xli?.pageInfo?.hasNextPage) problems.push("exchange line items truncated");
    const native = (xli?.nodes ?? []).filter((n) => (n.lineItems ?? []).some((li) => li?.variant?.id === variant));
    if (native.length > 1) problems.push(`${native.length} native exchange lines name ${variant}`);
    else if (native.length === 1) {
      deliveries.push({ lane: "native_exchange", returnGid: ret.id, exchangeLineItemId: native[0].id, variantGid: variant });
    }
    if (deliveries.length > 0 && sharing > 1) problems.push(`${sharing} lines of the order exchange to ${variant}`);
  }

  if (problems.length > 0) {
    return ambiguous(problems.join("; "), unattributed.length ? { unattributed } : {});
  }
  if (unattributed.length > 0) {
    return ambiguous(
      `refund(s) ${unattributed.join(", ")} moved money and name no line: a human binds or excludes them`,
      { unattributed }
    );
  }

  // ── The money the line's own effects moved ───────────────────────────────
  const money: PaidEvidence[] = [];
  const fromReturn = judgeOwnRefunds(ownReturn, ret.order?.presentmentCurrencyCode);
  if (fromReturn.v === "ambiguous") return ambiguous(fromReturn.reason);
  if (fromReturn.v === "paid") {
    money.push({ lane: "refund", refundId: fromReturn.refundId, amountCents: fromReturn.amountCents, currency: fromReturn.currency });
  }
  if (root) {
    const fromRoot = judgeOwnRefunds(ownRoot, root.presentmentCurrencyCode);
    if (fromRoot.v === "ambiguous") return ambiguous(fromRoot.reason);
    if (fromRoot.v === "paid") {
      money.push({
        lane: "root_refund",
        refundId: fromRoot.refundId,
        amountCents: fromRoot.amountCents,
        currency: fromRoot.currency,
        rootOrderGid: root.orderGid,
      });
    }
  }
  if (card) money.push(card);
  const idOf = (e: PaidEvidence) =>
    e.lane === "refund" || e.lane === "root_refund"
      ? e.refundId
      : e.lane === "credit"
        ? e.giftCardId
        : e.lane === "exchange"
          ? e.orderGid
          : e.exchangeLineItemId;

  if (deliveries.length > 1) return ambiguous(`delivered twice: ${deliveries.map(idOf).join(", ")}`);

  // A cash exchange: the pre-ledger writer delivered a replacement order.
  if (line.action === "CAMBIO" && !line.credit) {
    if (deliveries.length === 1) {
      const d = deliveries[0];
      return out("paid", `${d.lane === "exchange" ? "exchange order" : "native exchange"} ${idOf(d)}`, {
        evidence: d,
        moneyEffects: money.map(idOf),
      });
    }
    if (money.length > 0) {
      return ambiguous(`exchange line with no delivery but money paid by ${money.map(idOf).join(", ")}`);
    }
    return none(`no exchange order or native exchange line names ${variant}`);
  }

  // A money lane: a refund, or a gift card for a credit row.
  if (deliveries.length > 0) return ambiguous(`money line with a delivery ${deliveries.map(idOf).join(", ")}`);
  if (money.length > 1) return ambiguous(`paid more than once: ${money.map(idOf).join(", ")}`);
  if (money.length === 0) {
    return none(lane === "root_refund" ? `no paying refund on the return or the root carries [${line.returnLineItemId}]` : `no paying effect names ${gid}`);
  }
  const [paid] = money;
  if (line.credit !== (paid.lane === "credit")) {
    return ambiguous(`${line.credit ? "credit" : "refund"} row paid by ${paid.lane} ${idOf(paid)}`);
  }
  return out("paid", `${paid.lane === "credit" ? "gift card" : paid.lane === "root_refund" ? "root refund" : "refund"} ${idOf(paid)}`, {
    evidence: paid,
  });
}

/**
 * An operator rejected this line's reconciliation record ("no payment
 * happened"). That decision makes an ambiguous line unpaid — except where the
 * ambiguity is an unattributed refund: only a decision on THAT refund's id
 * (bind or exclude) clears it.
 */
export function afterOperatorRejection(c: Classification): Classification {
  if (c.cls !== "ambiguous" || (c.unattributed?.length ?? 0) > 0) return c;
  return { ...c, cls: "unpaid", reason: `operator: no legacy payment; was: ${c.reason}` };
}

/**
 * Is `order` the exchange order the pre-S2 `createOrder` made for this line?
 * By what that code wrote and nothing else: both tags (`Change`, `Order
 * <number>`), the original order's customer, exactly one line of the new
 * variant at the line's quantity, priced in EUR. Used by the classifier and by
 * the operator who resolves an unresolved legacy exchange.
 */
export function judgeLegacyExchangeOrder(
  check: { orderNumber: string; customerGid: string | null; newVariantGid: string | null; quantity: number },
  order: ExchangeOrderEvidence | null | undefined
):
  | {
      ok: true;
      orderGid: string;
      orderName: string;
      lineItemId: string;
      variantGid: string;
      quantity: number;
      unitCents: number;
    }
  | { ok: false; reason: string } {
  if (!order) return { ok: false, reason: "no such order" };
  const tags = order.tags ?? [];
  if (!tags.includes("Change") || !tags.includes(`Order ${check.orderNumber}`)) {
    return { ok: false, reason: `order ${order.id} is not tagged Change + Order ${check.orderNumber}` };
  }
  if (!check.newVariantGid) return { ok: false, reason: "no new variant to look for" };
  if (order.lineItems?.pageInfo?.hasNextPage) return { ok: false, reason: `order ${order.id} lines truncated` };
  const hits = (order.lineItems?.nodes ?? []).filter((n) => n.variant?.id === check.newVariantGid);
  if (hits.length !== 1) {
    return { ok: false, reason: `order ${order.id} has ${hits.length} lines of ${check.newVariantGid}` };
  }
  if (!check.customerGid || order.customer?.id !== check.customerGid) {
    return {
      ok: false,
      reason: `order ${order.id} customer ${order.customer?.id ?? "(none)"} vs ${check.customerGid ?? "(none)"}`,
    };
  }
  const hit = hits[0];
  if (Number(hit.quantity) !== check.quantity) {
    return { ok: false, reason: `order ${order.id} quantity ${hit.quantity} vs line ${check.quantity}` };
  }
  const money = hit.originalUnitPriceSet?.shopMoney;
  if (String(money?.currencyCode ?? "") !== "EUR") {
    return { ok: false, reason: `order ${order.id} currency ${money?.currencyCode ?? "(none)"}` };
  }
  return {
    ok: true,
    orderGid: order.id,
    orderName: String(order.name ?? ""),
    lineItemId: hit.id,
    variantGid: check.newVariantGid,
    quantity: check.quantity,
    unitCents: cents(money?.amount),
  };
}

/**
 * Santi, 30 Oct — "Reconcile settled lines only": R1 classifies the lines
 * marked settled (`refunded = true`) that no settlement operation covers.
 * A pending line is never R1's: it settles through S2 admission. The only
 * covered lines listed again are `swapCandidates` — settled exchanges already
 * recorded as paid — so R2 can show their returned/replacement values.
 */
export function reconcilePopulation<T extends Pick<LineFacts, "productsorderId" | "refunded">>(
  facts: readonly T[],
  coverage: { covered: ReadonlySet<number>; swapCandidates: ReadonlySet<number> }
): T[] {
  return facts.filter(
    (l) =>
      l.refunded &&
      (!coverage.covered.has(l.productsorderId) || coverage.swapCandidates.has(l.productsorderId))
  );
}

/** What the reconciliation read for a line, in cents: never what is owed. */
export function lineValues(line: Pick<LineFacts, "price" | "quantity">, c: Classification) {
  const returnedCents = lineTotalCents(line.price, line.quantity);
  const ev = c.evidence;
  const replacementCents = ev?.lane === "exchange" ? ev.unitCents * ev.quantity : null;
  return { returnedCents, replacementCents };
}

/**
 * Santi, 30 Oct — "You set each amount". Which approval a line admits, and
 * the most it may pay. Nothing here computes the amount: the approver states
 * it, and `approvalProblem` (lib/settlement/legacy.ts) checks it against this
 * cap. Only two findings admit an approval:
 *  - `unpaid` (D2): no payment found; cap = the returned value;
 *  - a paid exchange order whose replacement, read from Shopify, was cheaper
 *    than what came back, with NO refund or gift card found for the line
 *    (D1, `swap`); cap = returned − replacement.
 * Returned is the line total, rounded once (lib/basket.ts lineTotalCents).
 */
export function approvalBasisOf(
  line: Pick<LineFacts, "price" | "quantity">,
  c: Classification
): { ok: true; basis: "unpaid" | "swap"; capCents: number } | { ok: false; reason: string } {
  const { returnedCents, replacementCents } = lineValues(line, c);
  if (c.cls === "unpaid") return { ok: true, basis: "unpaid", capCents: returnedCents };
  if (c.cls === "paid" && replacementCents !== null) {
    // Delivery and the money difference are separate: a refund or gift card
    // found for the line means its difference was not left unpaid.
    if ((c.moneyEffects?.length ?? 0) > 0) {
      return { ok: false, reason: `difference already met by ${c.moneyEffects!.join(", ")}` };
    }
    const cap = returnedCents - replacementCents;
    return cap > 0
      ? { ok: true, basis: "swap", capCents: cap }
      : { ok: false, reason: `replacement ${replacementCents} ≥ returned ${returnedCents}: nothing owed` };
  }
  return { ok: false, reason: `class ${c.cls}${c.evidence ? `/${c.evidence.lane}` : ""} admits no approval` };
}

/**
 * The approval file: `productsorder_id,amount_cents,approved_by`, header
 * first, one line per approval. Strict: any malformed row refuses the file.
 */
export function parseApprovalFile(
  text: string
): { ok: true; rows: { productsorderId: number; amountCents: number; approvedBy: string }[] } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ok: false, error: "empty approval file" };
  const header = lines[0].split(",").map((h) => h.trim());
  if (header.join(",") !== "productsorder_id,amount_cents,approved_by") {
    return { ok: false, error: `header must be productsorder_id,amount_cents,approved_by (got ${lines[0]})` };
  }
  const rows: { productsorderId: number; amountCents: number; approvedBy: string }[] = [];
  const seen = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim());
    if (cells.length !== 3) return { ok: false, error: `line ${i + 1}: expected 3 columns` };
    const [po, amount, by] = cells;
    if (!/^[1-9]\d*$/.test(po)) return { ok: false, error: `line ${i + 1}: productsorder_id ${po}` };
    if (!/^[1-9]\d*$/.test(amount)) return { ok: false, error: `line ${i + 1}: amount_cents must be an integer > 0 (${amount})` };
    if (!by) return { ok: false, error: `line ${i + 1}: approved_by is required` };
    const id = Number(po);
    if (seen.has(id)) return { ok: false, error: `line ${i + 1}: productsorder ${id} approved twice` };
    seen.add(id);
    rows.push({ productsorderId: id, amountCents: Number(amount), approvedBy: by });
  }
  return { ok: true, rows };
}

/**
 * Codex #8: the PENDING NULL-action lines (not settled, no action) — outside
 * R1's population, never classified or written — listed for D3 with what
 * Shopify shows for them. A line with no Shopify return is needs-human, not
 * a D3 decision (lineAction.ts refuses it), so it is not listed here.
 */
export function pendingNullActionLines<T extends Pick<LineFacts, "refunded" | "action" | "returnId">>(facts: readonly T[]): T[] {
  return facts.filter((l) => !l.refunded && l.action === null && !!l.returnId);
}

/** What Shopify shows for a NULL-action line (R5 / D3), read-only. */
export function nullActionDiagnostics(
  line: Pick<LineFacts, "lineItemId">,
  ret: Read<ReturnEvidence | null> | null,
  exchangeOrders: Read<{ truncated: boolean; nodes: ExchangeOrderEvidence[] }> | null
): { returnStatus: string; refunds: string; exchangeOrders: string; nativeExchangeLines: string } {
  const r = ret?.ok ? ret.value : null;
  const gid = lineItemGid(line.lineItemId);
  const refunds = (r?.refunds?.nodes ?? []).filter((x) => (x.refundLineItems?.nodes ?? []).some((n) => n?.lineItem?.id === gid));
  return {
    returnStatus: ret === null ? "(no return)" : ret.ok ? String(r?.status ?? "(not found)") : `unreadable: ${ret.error}`,
    refunds: ret?.ok ? refunds.map((x) => x.id).join(" ") || "none" : "unreadable",
    exchangeOrders: exchangeOrders?.ok
      ? exchangeOrders.value.nodes.map((o) => o.name ?? o.id).join(" ") + (exchangeOrders.value.truncated ? " (truncated)" : "") || "none"
      : "unreadable",
    nativeExchangeLines: ret?.ok ? String((r?.exchangeLineItems?.nodes ?? []).length) : "unreadable",
  };
}
