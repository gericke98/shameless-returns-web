// Server-only. Decides, at first portal lookup, whether an order is one of our
// replacement orders and what its lines are really worth — from the
// settlement ledger's `replacement_lines` only (db/replacementLines.ts).
import { getOrderByIdFresh, getOrderTransactions } from "@/db/queries";
import { alertOps } from "@/actions/opsAlert";
import { resolveRootOrderId } from "@/lib/replacementOrigin";
import { pickRefundTransaction } from "@/lib/refundTransaction";
import { replacementFundingOf, unitPriceOf } from "@/db/replacementLines";
import type { OrderData } from "@/types";

export type ReplacementPlan =
  | { kind: "ordinary" }
  | {
      kind: "replacement";
      exchangeOf: string;
      /** The paid price of one unit, by the line item's bare Shopify id. For
       *  an S2 order it is the exact (unrounded) quotient of the line total. */
      priceByLineItem: Record<string, string>;
    }
  | { kind: "refused"; reason: string };

export async function planReplacementOrder(order: OrderData): Promise<ReplacementPlan> {
  const live = order.line_items.filter((item) => item.quantity > 0);

  // Ours only if settlement recorded it: created by S2 (its sourceIdentifier
  // names the exchange operation) or, from before S2, recorded by the legacy
  // reconciliation (S3 R1). Valued from those records or not at all — never
  // from tags or by matching variants (S3 R4). A line the records do not
  // cover refuses rather than falls back.
  const found = await replacementFundingOf({ id: String(order.id), sourceIdentifier: order.source_identifier });
  if (found.kind === "not-settlement") return { kind: "ordinary" };
  if (found.kind === "unfunded") {
    return refuseWith(order, found.sourceOrderId ?? "(unknown)", `settlement-order-unfunded:${found.reason}`);
  }
  const { funding } = found;
  const priceByLineItem: Record<string, string> = {};
  for (const item of live) {
    const line = funding.lineByLineItem.get(`gid://shopify/LineItem/${item.id}`);
    if (!line) return refuseWith(order, funding.sourceOrderId, `unfunded-line:${item.id}`);
    if (line.quantity !== Number(item.quantity)) {
      return refuseWith(order, funding.sourceOrderId, `funded-quantity:${item.id}`);
    }
    priceByLineItem[String(item.id)] = unitPriceOf(line);
  }
  return { kind: "replacement", exchangeOf: funding.sourceOrderId, priceByLineItem };
}

async function refuseWith(order: OrderData, original: string, reason: string): Promise<ReplacementPlan> {
  await alertOps(
    `[returns] REPLACEMENT ORDER NOT RETURNABLE ONLINE — ${order.name}`,
    `${order.name} is one of our exchange orders (original ${original}) and the portal could not value its lines.\n` +
      `Reason: ${reason}\n` +
      `The customer was told to contact us. Nothing was saved, so nothing was priced at list.`
  );
  return { kind: "refused", reason };
}

/** Follow the stored links to the order holding the real payment. */
export async function rootOrderIdOf(orderId: string): Promise<string> {
  return resolveRootOrderId(orderId, async (id) => {
    const row = await getOrderByIdFresh(id);
    return (row as any)?.exchangeOf ?? null;
  });
}

/**
 * Which payment a return on this order is refunded against. A replacement
 * order's own transaction is the €0.01 placeholder, so it is never used.
 */
export async function refundSourceFor(
  dbOrder: { id?: string; exchangeOf?: string | null } | null | undefined,
  fromReturn: { transactionId: string | null; transactionAmount: string | null }
) {
  if (!dbOrder?.exchangeOf) return fromReturn;
  const rootId = await rootOrderIdOf(String(dbOrder.id));
  const tx = pickRefundTransaction(await getOrderTransactions(rootId));
  return {
    transactionId: tx?.id ?? null,
    transactionAmount: tx?.amountSet?.shopMoney?.amount ?? null,
  };
}
