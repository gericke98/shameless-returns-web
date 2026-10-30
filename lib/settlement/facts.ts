// The Shopify facts admission freezes (S2 plan L3, L6), read once and turned
// into the plain shapes lib/settlement/plan.ts takes. Reads only.
//
// NOT "use server".
import { pickRefundTransaction } from "@/lib/refundTransaction";
import type { MoneySet } from "@/lib/returnPayload";
import {
  ADMISSION_PAYING_ORDER_QUERY,
  ADMISSION_RETURN_QUERY,
  DRAFT_ORDER_QUERY,
  read,
  type ReadResult,
} from "./reads";
import type { PayingOrder, ReturnFacts } from "./plan";

const moneySetOf = (set: any): MoneySet | null =>
  set
    ? {
        shop_money: { amount: set.shopMoney?.amount, currency_code: set.shopMoney?.currencyCode },
        presentment_money: {
          amount: set.presentmentMoney?.amount,
          currency_code: set.presentmentMoney?.currencyCode,
        },
      }
    : null;

export type ReturnRead = ReturnFacts & {
  /** Return line item gid → the fulfillment line item it returns. */
  fulfillmentByReturnLine: Map<string, string>;
};

export async function readReturnFacts(returnGid: string): Promise<ReadResult<ReturnRead | null>> {
  const result = await read(ADMISSION_RETURN_QUERY, { id: returnGid }, (data) => data?.return ?? null);
  if (!result.ok) return result;
  const ret = result.value;
  if (!ret) return { ok: true, value: null };
  if (ret.returnLineItems?.pageInfo?.hasNextPage || ret.reverseFulfillmentOrders?.pageInfo?.hasNextPage) {
    return { ok: false, error: `return ${returnGid} has more lines than one page` };
  }
  const returnLines = new Map<string, { quantity: number }>();
  const fulfillmentByReturnLine = new Map<string, string>();
  for (const node of ret.returnLineItems?.nodes ?? []) {
    returnLines.set(String(node.id), { quantity: Number(node.quantity) || 0 });
    if (node.fulfillmentLineItem?.id) {
      fulfillmentByReturnLine.set(String(node.id), String(node.fulfillmentLineItem.id));
    }
  }
  const reverseByFulfillment = new Map<string, { id: string; totalQuantity: number }>();
  for (const rfo of ret.reverseFulfillmentOrders?.nodes ?? []) {
    if (rfo?.lineItems?.pageInfo?.hasNextPage) {
      return { ok: false, error: `return ${returnGid} reverse fulfillment has more lines than one page` };
    }
    for (const item of rfo?.lineItems?.nodes ?? []) {
      const fli = item?.fulfillmentLineItem?.id;
      if (!fli) continue;
      if (reverseByFulfillment.has(fli)) {
        return { ok: false, error: `fulfillment line ${fli} is on two reverse-fulfillment lines` };
      }
      reverseByFulfillment.set(String(fli), { id: String(item.id), totalQuantity: Number(item.totalQuantity) || 0 });
    }
  }
  return {
    ok: true,
    value: {
      returnGid: String(ret.id),
      status: String(ret.status),
      hasExchangeLineItems: (ret.exchangeLineItems?.nodes ?? []).length > 0,
      returnLines,
      reverseByFulfillment,
      fulfillmentByReturnLine,
      orderGid: String(ret.order?.id ?? ""),
      customerGid: ret.order?.customer?.id ? String(ret.order.customer.id) : null,
      presentment: moneySetOf(ret.order?.totalPriceSet),
    },
  };
}

/**
 * The order holding the payment a refund goes against. `transactionId` is the
 * one named (a row's stored parent) or, when null, the largest settled
 * payment on that order (`pickRefundTransaction`, as `refundSourceFor` uses).
 */
export async function readPayingOrder(
  orderId: string,
  transactionId: string | null
): Promise<ReadResult<PayingOrder | null>> {
  const gid = `gid://shopify/Order/${orderId}`;
  const result = await read(ADMISSION_PAYING_ORDER_QUERY, { id: gid }, (data) => data?.order ?? null);
  if (!result.ok) return result;
  const order = result.value;
  if (!order) return { ok: true, value: null };
  const transactions: any[] = order.transactions ?? [];
  const gateways = new Map<string, string>(
    transactions.filter((t) => t?.id && t?.gateway).map((t) => [String(t.id), String(t.gateway)])
  );
  return {
    ok: true,
    value: {
      orderGid: gid,
      presentment: moneySetOf(order.totalPriceSet),
      gateways,
      transactionId: transactionId ?? pickRefundTransaction(transactions)?.id ?? null,
    },
  };
}

/** Does the stock-hold draft order exist right now? */
export async function readDraftExists(draftOrderId: string): Promise<ReadResult<boolean>> {
  return read(DRAFT_ORDER_QUERY, { id: draftOrderId }, (data) => !!data?.draftOrder);
}
