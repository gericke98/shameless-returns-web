/**
 * Building the `returnCreate` payload for a whole return, and reading the
 * response back onto the lines it came from.
 *
 * Pure — no network, no database.
 *
 * The unit of a return is the PARCEL, not the line item. `updateFinalOrder`
 * used to map over the products and call `returnCreate` once each, which gave
 * order #310756 two Shopify returns for one box and charged the 5 EUR return
 * shipping fee twice. It is also why validating an exchange minted one Shopify
 * order per line: each return was validated separately.
 */

import {
  noteForOtherReason,
  toShopifyReturnReason,
} from "@/lib/shopifyReturnReason";

/** The fields of a `productsorder` row this module needs, plus the fulfillment
 *  line item resolved from Shopify. Deliberately structural: callers pass
 *  their own rows without reshaping them. */
export type ReturnableLine = {
  variant_id: string;
  fulfillmentLineItemId: string | null;
  quantity?: number | null;
  action?: string | null;
  reason?: string | null;
  notes?: string | null;
  new_variant_id?: string | null;
};

export type ReturnLineItemInput = {
  fulfillmentLineItemId: string;
  quantity: number;
  returnReason: string;
  returnReasonNote?: string;
};

export type ExchangeLineItemInput = {
  variantId: string;
  quantity: number;
};

export type ReturnCreateInput = {
  orderId: string;
  returnLineItems: ReturnLineItemInput[];
  exchangeLineItems?: ExchangeLineItemInput[];
  returnShippingFee: {
    amount: { amount: string; currencyCode: string };
  };
};

/** How to express a EUR fee on an order that is shown in another currency. */
export type PresentmentRate = {
  /** The currency the ORDER is presented in — what Shopify validates against. */
  currencyCode: string;
  /** presentment / shop. Exactly 1 when the order is in the shop currency. */
  rate: number;
};

/** The shape Shopify uses for every dual-currency amount on an order. */
type MoneySet = {
  shop_money?: { amount?: string | null; currency_code?: string | null } | null;
  presentment_money?: { amount?: string | null; currency_code?: string | null } | null;
};

/** Presented in the shop currency: no conversion, no relabelling. */
const AT_PAR: PresentmentRate = { currencyCode: "EUR", rate: 1 };

const MAX_NOTE = 255;

/**
 * Derive the order's own EUR -> presentment conversion from any of its money
 * sets (`total_price_set` is the one the caller has to hand).
 *
 * The rate comes from the ORDER, not from a live FX feed, because the return
 * is bookkeeping *on that order*: a fee converted at today's mid-market rate
 * would disagree with the totals the customer was actually shown, and would
 * drift every time the record was recomputed. Shopify already stamped the rate
 * it used at purchase time into every money set; this reads it back.
 *
 * Never throws and never returns a non-finite rate. It runs inside the Stripe
 * webhook, *after* the customer's card has been charged, where the cost of a
 * bad input is a customer who paid and got nothing (order #310741). A missing,
 * malformed or zero money set therefore degrades to EUR at par — the behaviour
 * every Eurozone order already has, and the one that is right for the ~95% of
 * this store's traffic that is domestic.
 */
export function presentmentRateFromOrder(
  totalPriceSet: MoneySet | null | undefined
): PresentmentRate {
  const currencyCode = totalPriceSet?.presentment_money?.currency_code;
  const presentment = Number(totalPriceSet?.presentment_money?.amount);
  const shop = Number(totalPriceSet?.shop_money?.amount);

  if (!currencyCode) return AT_PAR;
  // A zero or unparseable shop amount would make the ratio Infinity or NaN.
  if (!Number.isFinite(presentment) || !Number.isFinite(shop) || shop <= 0) {
    return AT_PAR;
  }
  if (currencyCode === totalPriceSet?.shop_money?.currency_code) {
    return { currencyCode, rate: 1 };
  }

  return { currencyCode, rate: presentment / shop };
}

/**
 * Build the `ReturnInput` for one submission.
 *
 * `includeExchangeItems` gates Shopify's native exchange. With it off the
 * payload is exactly today's behaviour minus the duplication; with it on the
 * return also declares what the customer is exchanging FOR, which is what
 * links the replacement to the return in Shopify. Verified live: the store
 * accepts both return and exchange line items in a single call and applies one
 * shipping fee.
 */
export function buildReturnInput(
  shopifyOrderId: string,
  lines: ReturnableLine[],
  returnFeeEuros: number,
  options: { includeExchangeItems: boolean; presentment?: PresentmentRate }
): ReturnCreateInput {
  const presentment = options.presentment ?? AT_PAR;
  const returnLineItems = lines
    // A line with no fulfillment line item cannot be returned. Dropping it
    // beats sending null, which fails the mutation for every OTHER line too.
    .filter((line) => !!line.fulfillmentLineItemId)
    .map((line) => {
      // Per line. This was a single hardcoded COLOR for every return.
      const returnReason = toShopifyReturnReason(line.reason);
      const written = String(line.notes ?? "").trim().slice(0, MAX_NOTE);
      // An OTHER line MUST carry a note or Shopify rejects the whole mutation
      // — every line, not just this one. The customer's words win when they
      // wrote any; otherwise we supply the reason they picked.
      const note =
        written ||
        (returnReason === "OTHER"
          ? noteForOtherReason(line.reason).slice(0, MAX_NOTE)
          : "");
      return {
        fulfillmentLineItemId: line.fulfillmentLineItemId as string,
        quantity: Math.max(1, Number(line.quantity) || 1),
        returnReason,
        ...(note ? { returnReasonNote: note } : {}),
      };
    });

  const exchangeLineItems = options.includeExchangeItems
    ? lines
        .filter((line) => line.action === "CAMBIO" && !!line.new_variant_id)
        .map((line) => ({
          variantId: `gid://shopify/ProductVariant/${line.new_variant_id}`,
          quantity: Math.max(1, Number(line.quantity) || 1),
        }))
    : [];

  return {
    orderId: `gid://shopify/Order/${shopifyOrderId}`,
    returnLineItems,
    // Omitted rather than sent empty: Shopify treats an empty list as "this
    // return has an exchange with nothing in it".
    ...(exchangeLineItems.length ? { exchangeLineItems } : {}),
    // Once for the parcel. The fee is already computed from the whole basket's
    // weight in updateFinalOrder.
    //
    // In the order's PRESENTMENT currency, which is what Shopify validates:
    // "The presentment currency of the order needs to be used." Hardcoding EUR
    // here rejected the entire mutation for every order presented in anything
    // else — including free ones, since it is the currency that is checked and
    // not the amount. See tests/returnPresentmentCurrency.test.ts.
    returnShippingFee: {
      amount: {
        amount: (returnFeeEuros * presentment.rate).toFixed(2),
        currencyCode: presentment.currencyCode,
      },
    },
  };
}

type ReturnLineItemNode = {
  id: string;
  fulfillmentLineItem?: { id?: string | null } | null;
};

/**
 * Map the returned `ReturnLineItem` ids back onto our rows, keyed by variant id.
 *
 * Matching is on the fulfillment line item, never on array position: Shopify
 * makes no promise to echo the input order, and pairing by index would file one
 * line's refund against another's — which, since `returnLineItemId` is what
 * `returnRefund` spends, means refunding the wrong garment.
 *
 * A line Shopify did not echo back is simply absent from the result. The caller
 * can then leave that row unconfirmed rather than storing a wrong id.
 */
export function matchReturnLineItems(
  nodes: ReturnLineItemNode[],
  lines: ReturnableLine[]
): Record<string, string> {
  const byFulfillmentId = new Map<string, string>();
  for (const node of nodes ?? []) {
    const fulfillmentId = node?.fulfillmentLineItem?.id;
    if (fulfillmentId) byFulfillmentId.set(fulfillmentId, node.id);
  }

  const result: Record<string, string> = {};
  for (const line of lines) {
    if (!line.fulfillmentLineItemId) continue;
    const returnLineItemId = byFulfillmentId.get(line.fulfillmentLineItemId);
    if (returnLineItemId) result[line.variant_id] = returnLineItemId;
  }
  return result;
}
