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
    amount: { amount: string; currencyCode: "EUR" };
  };
};

const MAX_NOTE = 255;

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
  options: { includeExchangeItems: boolean }
): ReturnCreateInput {
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
    returnShippingFee: {
      amount: { amount: returnFeeEuros.toFixed(2), currencyCode: "EUR" },
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
