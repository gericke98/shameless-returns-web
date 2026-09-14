/**
 * Which transaction may a refund be charged against?
 *
 * Pure — no network, no db, no env — because this one choice decides whether a
 * customer is ever paid, and it is the only part of the refund path that can be
 * tested without moving money.
 *
 * `createReturn` used to store `order.transactions[0]` with no filter at all:
 * the query it came from selected neither `status` nor `kind`. When a customer's
 * first payment attempt FAILED and they paid again, `[0]` was the dead attempt,
 * and that id was written to `productsorder.transaction_id` for good. Every
 * later `returnRefund` against it came back "All transactions failed to be
 * refunded" — silently, once a morning, forever. #311882 waited five days that
 * way; #311658 twelve.
 */

export type ShopifyTransaction = {
  id: string;
  kind?: string | null;
  status?: string | null;
  amountSet?: { shopMoney?: { amount?: string | null } | null } | null;
};

/** The only kinds that ever took the customer's money. An ALLOWLIST, for the
 *  same reason the auto-approve gate uses one: a REFUND is money going the
 *  other way, an AUTHORIZATION never captured, and a VOID undid itself, so
 *  anything we fail to recognise must be refused rather than charged. */
const PAYING_KINDS = new Set(["SALE", "CAPTURE"]);

/** NaN for anything unparseable, which loses every comparison below — so a
 *  transaction with no readable amount can never be returned over a real one. */
function amountOf(tx: ShopifyTransaction): number {
  return Number(String(tx.amountSet?.shopMoney?.amount ?? "").trim());
}

/**
 * The largest settled payment on the order, or null when there is none.
 *
 * Null is a real answer and the caller must treat it as one: it means this
 * order cannot be refunded to a card at all, and sending an empty id to
 * Shopify instead would fail deep inside the money path where nothing is
 * watching.
 */
export function pickRefundTransaction(
  transactions: ShopifyTransaction[] | null | undefined
): ShopifyTransaction | null {
  const usable = (transactions ?? []).filter((tx) => {
    const status = String(tx.status ?? "").trim().toUpperCase();
    const kind = String(tx.kind ?? "").trim().toUpperCase();
    return status === "SUCCESS" && PAYING_KINDS.has(kind) && Number.isFinite(amountOf(tx));
  });
  if (usable.length === 0) return null;

  // Largest first. Sorting a COPY — `filter` already made one, but saying so
  // keeps this safe if that ever changes: reordering the caller's array is not
  // this function's business.
  return usable.slice().sort((a, b) => amountOf(b) - amountOf(a))[0];
}
