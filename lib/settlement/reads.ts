// Shopify READS for the settlement ledger: the facts admission freezes, and
// the evidence recovery re-reads (S2 plan L3, L5). Queries only — every
// mutation document lives in lib/settlement/effects.ts and nowhere else.
//
// NOT "use server". All on SHOPIFY_API_VERSION, each document validated
// against the 2026-04 schema.
import { shopifyGraphQL, graphQLErrors } from "./shopify";

/** The Return fields both the returnProcess answer and its evidence read select. */
export const RETURN_EVIDENCE_FIELDS = `
      id
      status
      returnLineItems(first: 50) {
        pageInfo { hasNextPage }
        nodes { id processedQuantity }
      }
      reverseFulfillmentOrders(first: 10) {
        pageInfo { hasNextPage }
        nodes {
          lineItems(first: 50) {
            pageInfo { hasNextPage }
            nodes { id dispositions { type quantity } }
          }
        }
      }
      refunds(first: 25) {
        pageInfo { hasNextPage }
        nodes {
          id
          refundLineItems(first: 50) {
            pageInfo { hasNextPage }
            nodes { lineItem { id } }
          }
          transactions(first: 10) {
            pageInfo { hasNextPage }
            nodes {
              kind
              status
              amountSet { presentmentMoney { amount currencyCode } }
              parentTransaction { id }
            }
          }
        }
      }`;

/** The Refund fields both the refundCreate answer and its evidence read select. */
export const REFUND_EVIDENCE_FIELDS = `
      id
      note
      transactions(first: 10) {
        pageInfo { hasNextPage }
        nodes {
          kind
          status
          amountSet { presentmentMoney { amount currencyCode } }
          parentTransaction { id }
        }
      }`;

/** The GiftCard fields both the giftCardCreate answer and its evidence read select. */
export const GIFT_CARD_EVIDENCE_FIELDS = `
      id
      lastCharacters
      note
      initialValue { amount currencyCode }
      customer { id }`;

/** The Order fields both the orderCreate answer and its evidence read select. */
export const ORDER_EVIDENCE_FIELDS = `
      id
      name
      sourceIdentifier
      customer { id }
      lineItems(first: 50) {
        pageInfo { hasNextPage }
        nodes {
          id
          quantity
          variant { id }
          customAttributes { key value }
        }
      }`;

export const RETURN_EVIDENCE_QUERY = `
  query SettlementReturnEvidence($id: ID!) {
    return(id: $id) {${RETURN_EVIDENCE_FIELDS}
    }
  }`;

export const REFUND_BY_ID_QUERY = `
  query SettlementRefundEvidence($id: ID!) {
    refund(id: $id) {${REFUND_EVIDENCE_FIELDS}
    }
  }`;

/** `first` is one more than we can judge: a full page means "more results", no verdict. */
export const ORDER_REFUNDS_PAGE = 100;
export const ORDER_REFUNDS_QUERY = `
  query SettlementOrderRefunds($id: ID!, $first: Int!) {
    order(id: $id) {
      id
      refunds(first: $first) {${REFUND_EVIDENCE_FIELDS}
      }
    }
  }`;

/** One order by id — the operator names the exchange order they found. */
export const ORDER_BY_ID_QUERY = `
  query SettlementExchangeOrderById($id: ID!) {
    order(id: $id) {${ORDER_EVIDENCE_FIELDS}
    }
  }`;

export const GIFT_CARD_SEARCH_QUERY = `
  query SettlementGiftCardEvidence($query: String!) {
    giftCards(first: 2, query: $query) {
      nodes {${GIFT_CARD_EVIDENCE_FIELDS}
      }
    }
  }`;

export const ORDER_SEARCH_QUERY = `
  query SettlementExchangeOrderEvidence($query: String!) {
    orders(first: 2, query: $query) {
      nodes {${ORDER_EVIDENCE_FIELDS}
      }
    }
  }`;

export const DRAFT_ORDER_QUERY = `
  query SettlementDraftOrder($id: ID!) {
    draftOrder(id: $id) { id }
  }`;

/** What admission freezes from the Shopify return. */
export const ADMISSION_RETURN_QUERY = `
  query SettlementAdmissionReturn($id: ID!) {
    return(id: $id) {
      id
      status
      exchangeLineItems(first: 1) { nodes { id } }
      returnLineItems(first: 50) {
        pageInfo { hasNextPage }
        nodes {
          id
          quantity
          processedQuantity
          ... on ReturnLineItem { fulfillmentLineItem { id } }
        }
      }
      reverseFulfillmentOrders(first: 10) {
        pageInfo { hasNextPage }
        nodes {
          lineItems(first: 50) {
            pageInfo { hasNextPage }
            nodes { id totalQuantity fulfillmentLineItem { id } }
          }
        }
      }
      order {
        id
        customer { id }
        totalPriceSet {
          shopMoney { amount currencyCode }
          presentmentMoney { amount currencyCode }
        }
      }
    }
  }`;

/** The order that holds the real payment: its transactions and money set. */
export const ADMISSION_PAYING_ORDER_QUERY = `
  query SettlementAdmissionPayingOrder($id: ID!) {
    order(id: $id) {
      id
      totalPriceSet {
        shopMoney { amount currencyCode }
        presentmentMoney { amount currencyCode }
      }
      transactions(first: 50) {
        id
        kind
        status
        gateway
        amountSet { shopMoney { amount } }
      }
    }
  }`;

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Answered with data and no top-level errors, or a reason we have no verdict. */
export async function read<T>(
  query: string,
  variables: Record<string, unknown>,
  pick: (data: any) => T
): Promise<ReadResult<T>> {
  const answer = await shopifyGraphQL(query, variables);
  if (answer.kind === "no-answer") return { ok: false, error: answer.error };
  const errors = graphQLErrors(answer.body);
  if (errors) return { ok: false, error: errors };
  return { ok: true, value: pick(answer.body?.data) };
}
