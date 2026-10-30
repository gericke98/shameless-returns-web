// S3 R1 — the Shopify READS the legacy reconciliation judges
// (lib/settlement/reconcile.ts). Queries only, on the ledger's one transport
// and pinned version (lib/settlement/shopify.ts, 2026-04); each document
// validated against the 2026-04 schema with the Shopify toolkit's validate.mjs.
//
// NOT "use server".
import { read } from "./reads";
import type {
  ExchangeOrderEvidence,
  GiftCardEvidence,
  Read,
  ReturnEvidence,
  RootRefundsEvidence,
} from "./reconcile";

/** The app's granted scopes: without read_all_orders Shopify answers only
 *  the last 60 days of orders, and every "no evidence" would be a lie. */
export const RECONCILE_SCOPES_QUERY = `
  query ReconcileScopes {
    currentAppInstallation {
      accessScopes { handle }
    }
  }`;

export const RECONCILE_RETURN_QUERY = `
  query ReconcileReturn($id: ID!) {
    return(id: $id) {
      id
      status
      order {
        id
        name
        presentmentCurrencyCode
        customer { id }
      }
      exchangeLineItems(first: 50) {
        pageInfo { hasNextPage }
        nodes {
          id
          lineItems { id variant { id } }
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
      }
    }
  }`;

/** One more than we can judge: a full page means "more refunds", no verdict. */
export const RECONCILE_ROOT_REFUNDS_PAGE = 100;
export const RECONCILE_ROOT_REFUNDS_QUERY = `
  query ReconcileRootRefunds($id: ID!) {
    order(id: $id) {
      id
      presentmentCurrencyCode
      refunds(first: 100) {
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
        }
      }
    }
  }`;

export const RECONCILE_GIFT_CARD_QUERY = `
  query ReconcileGiftCard($id: ID!) {
    giftCard(id: $id) {
      id
      initialValue { amount currencyCode }
      customer { id }
    }
  }`;

export const RECONCILE_EXCHANGE_ORDERS_QUERY = `
  query ReconcileExchangeOrders($query: String!) {
    orders(first: 10, query: $query) {
      pageInfo { hasNextPage }
      nodes {
        id
        name
        tags
        customer { id }
        lineItems(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            id
            quantity
            variant { id }
            originalUnitPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }`;

/** One order by id, with what judgeLegacyExchangeOrder checks — for the
 *  operator who names the legacy exchange order they found. */
export const RECONCILE_ORDER_QUERY = `
  query ReconcileOrderById($id: ID!) {
    order(id: $id) {
      id
      name
      tags
      customer { id }
      lineItems(first: 50) {
        pageInfo { hasNextPage }
        nodes {
          id
          quantity
          variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }`;

export async function readScopes(): Promise<Read<string[]>> {
  return read(RECONCILE_SCOPES_QUERY, {}, (d) =>
    (d?.currentAppInstallation?.accessScopes ?? []).map((s: any) => String(s?.handle))
  );
}

export async function readReturnEvidence(returnGid: string): Promise<Read<ReturnEvidence | null>> {
  return read(RECONCILE_RETURN_QUERY, { id: returnGid }, (d) => (d?.return ?? null) as ReturnEvidence | null);
}

export async function readRootRefunds(rootOrderId: string): Promise<Read<RootRefundsEvidence>> {
  const gid = rootOrderId.startsWith("gid://") ? rootOrderId : `gid://shopify/Order/${rootOrderId}`;
  const r = await read(RECONCILE_ROOT_REFUNDS_QUERY, { id: gid }, (d) => d?.order ?? null);
  if (!r.ok) return r;
  if (!r.value) return { ok: false, error: `root order ${gid} not found` };
  const refunds: any[] = r.value.refunds ?? [];
  return {
    ok: true,
    value: {
      orderGid: gid,
      presentmentCurrencyCode: r.value.presentmentCurrencyCode ?? null,
      refunds: refunds.length >= RECONCILE_ROOT_REFUNDS_PAGE ? null : refunds,
    },
  };
}

export async function readGiftCard(giftCardId: string): Promise<Read<GiftCardEvidence>> {
  const gid = giftCardId.startsWith("gid://") ? giftCardId : `gid://shopify/GiftCard/${giftCardId}`;
  return read(RECONCILE_GIFT_CARD_QUERY, { id: gid }, (d) => (d?.giftCard ?? null) as GiftCardEvidence);
}

/** Every order tagged both `Change` and `Order <number>` — the tags the
 *  pre-S2 `createOrder` wrote. The classifier re-checks both tags exactly. */
export function exchangeOrderSearch(orderNumber: string): string {
  return `tag:"Order ${orderNumber.replace(/"/g, "")}" AND tag:Change`;
}

export async function readExchangeOrders(
  orderNumber: string
): Promise<Read<{ truncated: boolean; nodes: ExchangeOrderEvidence[] }>> {
  return read(RECONCILE_EXCHANGE_ORDERS_QUERY, { query: exchangeOrderSearch(orderNumber) }, (d) => ({
    truncated: !!d?.orders?.pageInfo?.hasNextPage,
    nodes: (d?.orders?.nodes ?? []) as ExchangeOrderEvidence[],
  }));
}
