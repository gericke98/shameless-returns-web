// What Shopify answers, built from an operation's frozen `check` — so a test
// states the FACT ("the goods were processed", "a refund of the wrong amount
// exists") and the shape comes from one place.
import { SOURCE_LINE_PROPERTY } from "@/lib/settlement/types";

export function returnObject(
  check: any,
  facts: {
    processed?: number;
    notRestocked?: number;
    /** Each refund refunds `lineItem` (default: the op's own frozen line item). */
    refunds?: Array<{ amount?: string; status?: string; parent?: string; lineItem?: string }>;
  } = {}
) {
  const processed = facts.processed ?? check.quantity;
  const notRestocked = facts.notRestocked ?? processed;
  return {
    id: check.returnId,
    status: "CLOSED",
    returnLineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [{ id: check.returnLineItemId, quantity: check.quantity, processedQuantity: processed }],
    },
    reverseFulfillmentOrders: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          lineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: check.reverseFulfillmentLineItemId,
                dispositions: notRestocked ? [{ type: "NOT_RESTOCKED", quantity: notRestocked }] : [],
              },
            ],
          },
        },
      ],
    },
    refunds: {
      pageInfo: { hasNextPage: false },
      nodes: (facts.refunds ?? (check.refund ? [{}] : [])).map((r, i) => ({
        id: `gid://shopify/Refund/${i + 1}`,
        refundLineItems: {
          pageInfo: { hasNextPage: false },
          nodes: [{ lineItem: { id: r.lineItem ?? check.refund?.lineItemGid } }],
        },
        transactions: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              kind: "REFUND",
              status: r.status ?? "SUCCESS",
              parentTransaction: { id: r.parent ?? check.refund?.parentTransactionId },
              amountSet: {
                presentmentMoney: {
                  amount: r.amount ?? check.refund?.money.amount,
                  currencyCode: check.refund?.money.currencyCode ?? "EUR",
                },
              },
            },
          ],
        },
      })),
    },
  };
}

export function refundObject(check: any, over: { amount?: string; status?: string; note?: string } = {}) {
  return {
    id: "gid://shopify/Refund/9",
    note: over.note ?? `${check.marker} Return`,
    transactions: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          kind: "REFUND",
          status: over.status ?? "SUCCESS",
          parentTransaction: { id: check.parentTransactionId },
          amountSet: { presentmentMoney: { amount: over.amount ?? check.money.amount, currencyCode: check.money.currencyCode } },
        },
      ],
    },
  };
}

export function giftCardObject(check: any, over: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/GiftCard/5",
    customer: { id: check.customerGid },
    initialValue: check.money,
    lastCharacters: check.code.slice(-4),
    note: `credit ${check.noteMarker}`,
    ...over,
  };
}

export function orderObject(check: any, over: { quantityDelta?: number; dropLine?: boolean } = {}) {
  const lines = check.lines.slice(0, over.dropLine ? -1 : undefined);
  return {
    id: "gid://shopify/Order/555",
    name: "#555",
    sourceIdentifier: check.sourceIdentifier,
    customer: check.customerGid ? { id: check.customerGid } : null,
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: lines.map((l: any, i: number) => ({
        id: `gid://shopify/LineItem/${900 + i}`,
        quantity: l.quantity + (over.quantityDelta ?? 0),
        variant: { id: l.variantGid },
        customAttributes: [{ key: SOURCE_LINE_PROPERTY, value: String(l.sourceProductsorderId) }],
      })),
    },
  };
}
