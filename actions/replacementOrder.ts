// Server-only. Decides, at first portal lookup, whether an order is one of our
// replacement orders and what its lines are really worth. The rules are pure
// and live in lib/replacementOrigin.ts; this file only loads the original.
import { getOrderByIdFresh, getOrderByNumberFresh, getOrderTransactions } from "@/db/queries";
import { alertOps } from "@/actions/opsAlert";
import {
  originalOrderNumberFromTags,
  planReplacementPricing,
  resolveRootOrderId,
  type OriginalRow,
} from "@/lib/replacementOrigin";
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

  // Created by settlement (S2), known by the operation id it carries as its
  // source_identifier: valued from that operation's records, or not at all —
  // never from tags (finding 5).
  const found = await replacementFundingOf({ id: String(order.id), sourceIdentifier: order.source_identifier });
  if (found.kind === "unfunded") {
    return refuseWith(order, found.sourceOrderId ?? "(unknown)", `settlement-order-unfunded:${found.reason}`);
  }
  if (found.kind === "funded") {
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

  // Created before S2: reconstructed from the tags and the original's rows.
  const originalNumber = originalOrderNumberFromTags(order.tags);
  if (!originalNumber) return { kind: "ordinary" };
  const refuse = (reason: string) => refuseWith(order, originalNumber, reason);

  const original = await getOrderByNumberFresh(originalNumber);
  if (!original) return refuse(`original-not-found:${originalNumber}`);

  const lines = live.map((item) => ({ variant_id: item.variant_id, product_id: item.product_id }));
  const plan = planReplacementPricing(
    lines,
    ((original as any).products ?? []) as OriginalRow[]
  );
  if (!plan.ok) return refuse(plan.reason);

  const priceByLineItem: Record<string, string> = {};
  for (const item of live) priceByLineItem[String(item.id)] = plan.priceByVariant[String(item.variant_id)];
  return { kind: "replacement", exchangeOf: String(original.id), priceByLineItem };
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
