// S3 R1 — the legacy reconciliation classifier. Pure: no db, no network.
//
// docs/superpowers/specs/2026-10-30-settlement-S3-legacy-plan.md
//
// For every confirmed line the ledger has never touched, the payment its lane
// would have made is looked for in Shopify, by explicit identity only:
//
//   refund       a refund on the line's return whose refundLineItems name its
//                order line item, with a SUCCESS refund transaction;
//   root_refund  (a line on one of our replacement orders) a refund on the
//                ROOT order whose note carries the bracketed marker
//                `[<return line item gid>]` the pre-S2 code wrote;
//   credit       the gift card in `gift_card_id`, whose customer is the
//                order's customer;
//   exchange     exactly one order tagged `Change` + `Order <number>` whose
//                lines contain the new variant, or — a native exchange — the
//                return's exchange line items naming it.
//
// Amounts and currencies are checked only after identity matched. A line is
// `paid` (evidence found and verified), `unpaid` (a complete read found none,
// on a return that is open or closed), `ambiguous` (several matches, an
// unreadable or truncated read, a recipient or currency that does not match)
// or `null-action` (no lane: a human decides, D3).
import { variantGid } from "@/lib/shopifyIds";

export type Lane = "refund" | "root_refund" | "credit" | "exchange";
export type ReconcileClass = "paid" | "unpaid" | "ambiguous" | "null-action";

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

/** Everything read for one line's lane. Only the lane's own reads are set. */
export type LineReads = {
  ret: Read<ReturnEvidence | null>;
  rootRefunds?: Read<RootRefundsEvidence>;
  giftCard?: Read<GiftCardEvidence>;
  /** Orders the tag search returned for this line's order number. */
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
};

/** Facts about the line's siblings that decide identity, computed over the whole population. */
export type SharedIdentity = {
  /** Gift card id → how many lines name it. */
  giftCardUses: Map<string, number>;
  /** `<order id>|<variant gid>` → how many confirmed CAMBIO lines of that order name it. */
  exchangeVariantUses: Map<string, number>;
};

const cents = (amount: unknown) => Math.round(Number(amount) * 100);
const lineItemGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/LineItem/${id}`);
const giftCardGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/GiftCard/${id}`);

export function laneOf(line: Pick<LineFacts, "action" | "credit" | "isReplacement">): Lane | null {
  if (line.action === "CAMBIO") return "exchange";
  if (line.action === "DEVOLUCIÓN") {
    if (line.credit) return "credit";
    return line.isReplacement ? "root_refund" : "refund";
  }
  return null;
}

export const exchangeVariantKey = (orderId: string, newVariantId: string | null) =>
  `${orderId}|${variantGid(newVariantId) ?? ""}`;

export function sharedIdentity(lines: LineFacts[]): SharedIdentity {
  const giftCardUses = new Map<string, number>();
  const exchangeVariantUses = new Map<string, number>();
  for (const l of lines) {
    if (l.giftCardId) {
      const k = giftCardGid(l.giftCardId);
      giftCardUses.set(k, (giftCardUses.get(k) ?? 0) + 1);
    }
    if (l.action === "CAMBIO" && l.newVariantId) {
      const k = exchangeVariantKey(l.orderId, l.newVariantId);
      exchangeVariantUses.set(k, (exchangeVariantUses.get(k) ?? 0) + 1);
    }
  }
  return { giftCardUses, exchangeVariantUses };
}

/** Group lines by explicit identity: one Shopify return and one tender is one historical submission. */
export function groupKey(line: Pick<LineFacts, "returnId" | "credit">): string {
  return `${line.returnId ?? "(none)"}|${line.credit ? "credit" : "refund"}`;
}

const PROCESSED_OR_OPEN = new Set(["OPEN", "CLOSED"]);

type MoneyVerdict =
  | { v: "paid"; refundId: string; amountCents: number; currency: string }
  | { v: "none" }
  | { v: "ambiguous"; reason: string };

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

export function classifyLine(line: LineFacts, reads: LineReads, shared: SharedIdentity): Classification {
  const lane = laneOf(line);
  const base = { productsorderId: line.productsorderId, lane };
  const ret = reads.ret.ok ? reads.ret.value : null;
  const returnStatus = ret?.status ?? null;
  const out = (cls: ReconcileClass, reason: string, evidence?: PaidEvidence): Classification => ({
    ...base,
    cls,
    reason,
    returnStatus,
    ...(evidence ? { evidence } : {}),
  });
  const ambiguous = (reason: string) => out("ambiguous", reason);
  /** No evidence after a complete read: unpaid, but only for a return that is open or processed. */
  const none = (reason: string) =>
    PROCESSED_OR_OPEN.has(String(returnStatus)) ? out("unpaid", reason) : ambiguous(`${reason}; return ${returnStatus}`);

  if (!lane) return out("null-action", "action is NULL");
  if (!line.returnId || !line.returnLineItemId) return ambiguous("no Shopify return on the line");
  if (!reads.ret.ok) return ambiguous(`return unreadable: ${reads.ret.error}`);
  if (!ret) return ambiguous(`return ${line.returnId} not found`);

  if (lane === "refund") {
    const refunds = ret.refunds;
    if (refunds?.pageInfo?.hasNextPage) return ambiguous("return refunds truncated");
    const gid = lineItemGid(line.lineItemId);
    const own = [];
    for (const r of refunds?.nodes ?? []) {
      if (r.refundLineItems?.pageInfo?.hasNextPage) return ambiguous(`refund ${r.id} line items truncated`);
      if ((r.refundLineItems?.nodes ?? []).some((n) => n?.lineItem?.id === gid)) own.push(r);
    }
    const money = judgeOwnRefunds(own, ret.order?.presentmentCurrencyCode);
    if (money.v === "ambiguous") return ambiguous(money.reason);
    if (money.v === "none") return none(`no paying refund names ${gid}`);
    return out("paid", `refund ${money.refundId}`, {
      lane,
      refundId: money.refundId,
      amountCents: money.amountCents,
      currency: money.currency,
    });
  }

  if (lane === "root_refund") {
    const r = reads.rootRefunds;
    if (!r) return ambiguous("root order not read");
    if (!r.ok) return ambiguous(`root order unreadable: ${r.error}`);
    if (!r.value.refunds) return ambiguous("root order refunds truncated");
    const marker = `[${line.returnLineItemId}]`;
    const own = r.value.refunds.filter((x) => String(x.note ?? "").includes(marker));
    const money = judgeOwnRefunds(own, r.value.presentmentCurrencyCode);
    if (money.v === "ambiguous") return ambiguous(money.reason);
    if (money.v === "none") return none(`no paying refund on the root carries ${marker}`);
    return out("paid", `root refund ${money.refundId}`, {
      lane,
      refundId: money.refundId,
      amountCents: money.amountCents,
      currency: money.currency,
      rootOrderGid: r.value.orderGid,
    });
  }

  if (lane === "credit") {
    // The spec's fallback — search the customer's gift cards for one whose
    // note names the order — cannot be built: pre-S2 cards were created with
    // no note at all, and an amount is never identity. So without the stored
    // id there is no identity to look for.
    if (!line.giftCardId) return ambiguous("no gift_card_id: no identity to look for");
    const gid = giftCardGid(line.giftCardId);
    const uses = shared.giftCardUses.get(gid) ?? 0;
    if (uses > 1) return ambiguous(`gift card ${gid} is named by ${uses} lines`);
    const g = reads.giftCard;
    if (!g) return ambiguous("gift card not read");
    if (!g.ok) return ambiguous(`gift card unreadable: ${g.error}`);
    const card = g.value;
    if (!card) return ambiguous(`gift card ${gid} not found`);
    const customer = ret.order?.customer?.id ?? null;
    if (!customer || card.customer?.id !== customer) {
      return ambiguous(`gift card ${gid} customer ${card.customer?.id ?? "(none)"} vs order ${customer ?? "(none)"}`);
    }
    const currency = String(card.initialValue?.currencyCode ?? "");
    if (currency !== "EUR") return ambiguous(`gift card ${gid} currency ${currency || "(none)"}`);
    return out("paid", `gift card ${gid}`, {
      lane,
      giftCardId: card.id,
      amountCents: cents(card.initialValue?.amount),
      currency,
    });
  }

  // exchange
  const variant = variantGid(line.newVariantId);
  if (!variant) return ambiguous("exchange line has no new variant");
  const sharing = shared.exchangeVariantUses.get(exchangeVariantKey(line.orderId, line.newVariantId)) ?? 0;
  const e = reads.exchangeOrders;
  if (!e) return ambiguous("exchange orders not searched");
  if (!e.ok) return ambiguous(`exchange order search unreadable: ${e.error}`);
  if (e.value.truncated) return ambiguous("exchange order search truncated");
  const tag = `Order ${line.orderNumber}`;
  const candidates = [];
  for (const order of e.value.nodes) {
    const tags = order.tags ?? [];
    if (!tags.includes("Change") || !tags.includes(tag)) continue;
    if (order.lineItems?.pageInfo?.hasNextPage) return ambiguous(`order ${order.id} lines truncated`);
    const hits = (order.lineItems?.nodes ?? []).filter((n) => n.variant?.id === variant);
    if (hits.length > 0) candidates.push({ order, hits });
  }
  if (candidates.length > 1) return ambiguous(`${candidates.length} exchange orders contain ${variant}`);
  if (candidates.length === 1) {
    if (sharing > 1) return ambiguous(`${sharing} lines of the order exchange to ${variant}`);
    const judged = judgeLegacyExchangeOrder(
      {
        orderNumber: line.orderNumber,
        customerGid: ret.order?.customer?.id ?? null,
        newVariantGid: variant,
        quantity: line.quantity,
      },
      candidates[0].order
    );
    if (!judged.ok) return ambiguous(judged.reason);
    return out("paid", `exchange order ${judged.orderName || judged.orderGid}`, {
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

  // No order of ours: a native exchange on the return itself?
  const xli = ret.exchangeLineItems;
  if (xli?.pageInfo?.hasNextPage) return ambiguous("exchange line items truncated");
  const native = (xli?.nodes ?? []).filter((n) => (n.lineItems ?? []).some((li) => li?.variant?.id === variant));
  if (native.length > 1) return ambiguous(`${native.length} native exchange lines name ${variant}`);
  if (native.length === 1) {
    if (sharing > 1) return ambiguous(`${sharing} lines of the order exchange to ${variant}`);
    return out("paid", `native exchange ${native[0].id}`, {
      lane: "native_exchange",
      returnGid: ret.id,
      exchangeLineItemId: native[0].id,
      variantGid: variant,
    });
  }
  return none(`no exchange order or native exchange line names ${variant}`);
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
