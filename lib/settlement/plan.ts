// Admission's operation set (S2 plan L3): from the agreement and the facts read
// at admission, every external effect the admitted lines require, each with
// its exact frozen request. Pure — no db, no network, no clock, no randomness
// (ids and gift-card codes are passed in).
//
// Amounts come from `submission_lines` only. Nothing here recomputes a price,
// a fee or a credit multiplier: `pay_cents` is already the agreed amount in
// tender units (credit already ×1.15, S1).
import { refundTransactionAmount, type MoneySet } from "@/lib/returnPayload";
import { buildExchangeOrderVariables, type ExchangeOrderSource } from "./exchangeOrderInput";
import type { NewOperation, SubmissionForAdmission, SubmissionLineRow } from "./ledger";
import type { FrozenMoney, OpKind, OpRequest } from "./types";

export type ReturnFacts = {
  returnGid: string;
  status: string;
  hasExchangeLineItems: boolean;
  /** Return line item gid → its quantity. */
  returnLines: Map<string, { quantity: number }>;
  /** Fulfillment line item gid → the reverse-fulfillment line covering it. */
  reverseByFulfillment: Map<string, { id: string; totalQuantity: number }>;
  orderGid: string;
  customerGid: string | null;
  presentment: MoneySet | null;
};

/** The order that holds the customer's real payment (a replacement's root). */
export type PayingOrder = {
  orderGid: string;
  presentment: MoneySet | null;
  /** Transaction gid → gateway, for every transaction a refund may name. */
  gateways: Map<string, string>;
  /** The transaction a refund on this order is charged against. */
  transactionId: string | null;
};

export type PlanInput = {
  submission: SubmissionForAdmission;
  /** EVERY line of the submission. */
  lines: SubmissionLineRow[];
  /** The productsorder ids being admitted (already expanded to whole exchanges). */
  admit: number[];
  existing: Array<{ id: string; kind: OpKind; scopeKey: string }>;
  /** productsorder row facts: its Shopify return and its stored refund parent. */
  rows: Map<number, { returnId: string | null; transactionId: string | null }>;
  returns: Map<string, ReturnFacts>;
  /** Set when the order is one of our replacement orders (exchange_of). */
  isReplacement: boolean;
  /** Required for refund-tender money outside a returnProcess (root/residual). */
  paying: PayingOrder | null;
  reservation: { draftOrderId: string; existed: boolean } | null;
  order: ExchangeOrderSource & { id: string };
  newId: () => string;
  newGiftCardCode: () => string;
};

export type Plan =
  | { ok: true; ops: NewOperation[]; reverseFulfillment: Array<{ productsorder_id: number; rfo: string }> }
  | { ok: false; held: string };

const held = (reason: string): Plan => ({ ok: false, held: reason });

export const scopeKeys = {
  money: (s: string, po: number) => `money:${s}:${po}`,
  goods: (s: string, po: number) => `goods:${s}:${po}`,
  exchange: (s: string) => `exchange:${s}`,
  hold: (s: string) => `hold:${s}`,
  residual: (s: string) => `residual:${s}`,
};

const euros = (cents: number) => cents / 100;
/** S1 freezes the REST (bare) line item id; Shopify's refunds name the gid. */
const lineItemGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/LineItem/${id}`);
const shopMoney = (cents: number, currencyCode: string): FrozenMoney => ({
  amount: (cents / 100).toFixed(2),
  currencyCode,
});

export function planAdmission(input: PlanInput): Plan {
  const { submission: s, lines } = input;
  const byId = new Map(lines.map((l) => [l.productsorderId, l]));
  const scopes = new Set(input.existing.map((o) => o.scopeKey));
  const ops: NewOperation[] = [];
  const reverseFulfillment: Array<{ productsorder_id: number; rfo: string }> = [];
  const add = (op: Omit<NewOperation, "currency"> & { currency?: string }) => {
    if (scopes.has(op.scope_key)) return;
    scopes.add(op.scope_key);
    ops.push({ currency: s.currency, ...op });
  };

  // Shopify's return lifecycle gates every NEW obligation (finding 2): an
  // operation may only be created against an OPEN return. A closed or
  // cancelled return was settled or withdrawn outside this ledger, so creating
  // money against it could pay twice. Operations admitted while it was OPEN
  // are untouched by this — recovery executes them after closure.
  const notOpen = (ret: ReturnFacts, scopeKey: string): Plan | null =>
    !scopes.has(scopeKey) && ret.status !== "OPEN" ? held(`return-not-open:${ret.status}`) : null;

  if (s.state !== "accepted") return held(`not-accepted:${s.state}`);
  if (s.holder === "cancellation") return held("cancelling");

  for (const po of input.admit) {
    const line = byId.get(po);
    if (!line) return held(`not-in-submission:${po}`);
    if (!line.returnLineItemId) return held(`no-return-line:${po}`);
    const row = input.rows.get(po);
    if (!row?.returnId) return held(`no-return:${po}`);
    const ret = input.returns.get(row.returnId);
    if (!ret) return held(`shopify-unreadable:${row.returnId}`);
    // Historical native exchanges are not ours to settle (L6): S3 lists them.
    if (ret.hasExchangeLineItems) return held("native-exchange");

    const rli = ret.returnLines.get(line.returnLineItemId);
    if (!rli) return held(`return-line-missing:${po}`);
    if (rli.quantity < line.quantity) return held(`return-quantity:${po}`);

    let rfo = line.reverseFulfillmentLineItemId;
    if (!rfo) {
      const found = line.fulfillmentLineItemId
        ? ret.reverseByFulfillment.get(line.fulfillmentLineItemId)
        : undefined;
      if (!found) return held(`no-reverse-fulfillment-line:${po}`);
      rfo = found.id;
      reverseFulfillment.push({ productsorder_id: po, rfo });
    }

    const goodsInput = (financialTransfer?: Record<string, unknown>, notify = false) => ({
      input: {
        returnId: ret.returnGid,
        notifyCustomer: notify,
        returnLineItems: [
          {
            id: line.returnLineItemId,
            quantity: line.quantity,
            dispositions: [
              {
                reverseFulfillmentOrderLineItemId: rfo,
                quantity: line.quantity,
                dispositionType: "NOT_RESTOCKED",
              },
            ],
          },
        ],
        ...(financialTransfer ? { financialTransfer } : {}),
      },
    });
    const goodsCheck = {
      returnId: ret.returnGid,
      returnLineItemId: line.returnLineItemId,
      reverseFulfillmentLineItemId: rfo!,
      quantity: line.quantity,
    };

    const refundInReturn = s.tender === "refund" && !input.isReplacement && line.payCents > 0;
    if (refundInReturn) {
      // Goods and money in ONE returnProcess: the money is bounded by the
      // line's unprocessed quantity, so it cannot apply twice.
      const parentId = row.transactionId;
      if (!parentId) return held(`no-refund-transaction:${po}`);
      const money = refundTransactionAmount(euros(line.payCents), ret.presentment);
      const closed = notOpen(ret, scopeKeys.money(s.id, po));
      if (closed) return closed;
      const request: OpRequest = {
        kind: "process_refund",
        variables: goodsInput(
          {
            issueRefund: {
              orderTransactions: [
                { parentId, transactionAmount: { amount: money.amount, currencyCode: money.currencyCode } },
              ],
            },
          },
          true
        ),
        check: {
          ...goodsCheck,
          refund: { parentTransactionId: parentId, money, lineItemGid: lineItemGid(line.shopifyLineItemId) },
        },
      };
      add({
        id: input.newId(),
        kind: "process_refund",
        scope_key: scopeKeys.money(s.id, po),
        members: [po],
        after: null,
        request,
        amount_cents: line.payCents,
      });
      continue;
    }

    const goodsClosed = notOpen(ret, scopeKeys.goods(s.id, po));
    if (goodsClosed) return goodsClosed;
    add({
      id: input.newId(),
      kind: "process_goods",
      scope_key: scopeKeys.goods(s.id, po),
      members: [po],
      after: null,
      request: { kind: "process_goods", variables: goodsInput(), check: goodsCheck },
      amount_cents: 0,
    });

    if (line.payCents > 0) {
      const moneyClosed = notOpen(ret, scopeKeys.money(s.id, po));
      if (moneyClosed) return moneyClosed;
      const money = moneyOperation(input, ret, line.payCents, scopeKeys.money(s.id, po), [po]);
      if ("held" in money) return held(money.held);
      add(money);
    }
  }

  // One replacement order for every exchanged garment of the submission, and
  // the hold released only after it exists (L6).
  const cambio = lines.filter((l) => l.action === "CAMBIO");
  if (cambio.length > 0 && cambio.some((l) => input.admit.includes(l.productsorderId))) {
    const members = cambio.map((l) => l.productsorderId);
    const existingExchange = input.existing.find((o) => o.scopeKey === scopeKeys.exchange(s.id));
    let exchangeId = existingExchange?.id ?? null;
    if (!existingExchange) {
      // The customer the order is created for: the one on the return's order.
      const anyReturn = input.returns.get(input.rows.get(members[0])?.returnId ?? "");
      if (!anyReturn) return held("shopify-unreadable:exchange");
      const exchangeClosed = notOpen(anyReturn, scopeKeys.exchange(s.id));
      if (exchangeClosed) return exchangeClosed;
      exchangeId = input.newId();
      const built = buildExchangeOrderVariables({
        opId: exchangeId,
        order: input.order,
        customerGid: anyReturn.customerGid,
        lines: cambio.map((l) => ({
          productsorderId: l.productsorderId,
          newVariantId: l.newVariantId,
          quantity: l.quantity,
        })),
        holdExisted: input.reservation?.existed === true,
      });
      if (!built.ok) return held(built.reason);
      const lineItems = built.variables.order.lineItems as Array<{ variantId: string; quantity: number }>;
      add({
        id: exchangeId,
        kind: "exchange_order",
        scope_key: scopeKeys.exchange(s.id),
        members,
        after: null,
        request: {
          kind: "exchange_order",
          variables: built.variables,
          check: {
            sourceIdentifier: exchangeId,
            customerGid: anyReturn.customerGid,
            lines: cambio.map((l, i) => ({
              sourceProductsorderId: l.productsorderId,
              variantGid: lineItems[i].variantId,
              quantity: l.quantity,
              stripeFundedCents: l.stripeFundedCents,
            })),
          },
        },
        amount_cents: 0,
      });
    }
    if (input.reservation) {
      const holdReturn = input.returns.get(input.rows.get(members[0])?.returnId ?? "");
      if (!holdReturn) return held("shopify-unreadable:hold");
      const holdClosed = notOpen(holdReturn, scopeKeys.hold(s.id));
      if (holdClosed) return holdClosed;
      add({
        id: input.newId(),
        kind: "release_hold",
        scope_key: scopeKeys.hold(s.id),
        members,
        after: exchangeId,
        request: {
          kind: "release_hold",
          variables: { input: { id: input.reservation.draftOrderId } },
          check: { draftOrderId: input.reservation.draftOrderId, orderId: input.order.id },
        },
        amount_cents: 0,
      });
    }
  }

  // The submission's own indivisible cents: once, and only when this
  // admission leaves no line that owes money without its money operation.
  // Its members are EVERY paying line (finding 7): completion is "every op a
  // line belongs to is done", so no paying line — and so not the return —
  // reads as settled or refunded while the residual is still owed.
  if (s.residualCents > 0 && !scopes.has(scopeKeys.residual(s.id))) {
    const payLines = lines.filter((l) => l.payCents > 0);
    if (payLines.length === 0) return held("residual-without-paying-line");
    const everyPayLineAdmitted = payLines.every((l) => scopes.has(scopeKeys.money(s.id, l.productsorderId)));
    if (everyPayLineAdmitted) {
      const anyLine = lines.find((l) => input.rows.get(l.productsorderId)?.returnId);
      const ret = anyLine ? input.returns.get(input.rows.get(anyLine.productsorderId)!.returnId!) : undefined;
      if (!ret) return held("shopify-unreadable:residual");
      const residualClosed = notOpen(ret, scopeKeys.residual(s.id));
      if (residualClosed) return residualClosed;
      const money = moneyOperation(
        input,
        ret,
        s.residualCents,
        scopeKeys.residual(s.id),
        payLines.map((l) => l.productsorderId)
      );
      if ("held" in money) return held(money.held);
      add(money);
    }
  }

  return { ok: true, ops, reverseFulfillment };
}

/**
 * Money that is not folded into a returnProcess: a gift card in credit, or a
 * refundCreate on the order holding the real payment (a replacement's root,
 * or — for the residual — the order itself).
 */
function moneyOperation(
  input: PlanInput,
  ret: ReturnFacts,
  cents: number,
  scopeKey: string,
  members: number[]
): NewOperation | { held: string } {
  const id = input.newId();
  const marker = `[${id}]`;
  if (input.submission.tender === "credit") {
    if (!ret.customerGid) return { held: "no-customer-for-gift-card" };
    const code = input.newGiftCardCode();
    const money = shopMoney(cents, input.submission.currency);
    return {
      id,
      kind: "gift_card",
      scope_key: scopeKey,
      members,
      after: null,
      currency: input.submission.currency,
      amount_cents: cents,
      request: {
        kind: "gift_card",
        variables: {
          input: {
            initialValue: money.amount,
            code,
            customerId: ret.customerGid,
            note: `Store credit for the return on ${input.order.orderNumber} ${marker}`,
          },
        },
        check: { code, customerGid: ret.customerGid, money, noteMarker: marker },
      },
    };
  }

  const paying = input.paying;
  if (!paying?.transactionId) return { held: "no-refund-transaction" };
  const gateway = paying.gateways.get(paying.transactionId);
  if (!gateway) return { held: "refund-transaction-not-on-paying-order" };
  const money = refundTransactionAmount(euros(cents), paying.presentment);
  return {
    id,
    kind: "root_refund",
    scope_key: scopeKey,
    members,
    after: null,
    currency: input.submission.currency,
    amount_cents: cents,
    request: {
      kind: "root_refund",
      variables: {
        input: {
          orderId: paying.orderGid,
          notify: true,
          note: `${marker} Return on ${input.order.orderNumber}`,
          currency: money.currencyCode,
          transactions: [
            {
              orderId: paying.orderGid,
              parentId: paying.transactionId,
              amount: money.amount,
              gateway,
              kind: "REFUND",
            },
          ],
        },
      },
      check: {
        orderGid: paying.orderGid,
        marker,
        parentTransactionId: paying.transactionId,
        money,
      },
    },
  };
}
