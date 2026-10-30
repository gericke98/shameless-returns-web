// Server-only. Decides, at first portal lookup, whether an order is one of our
// replacement orders and what its lines are really worth — from the
// settlement ledger's `replacement_lines` only (db/replacementLines.ts).
import { getOrderByIdFresh, getOrderTransactions } from "@/db/queries";
import { alertOps } from "@/actions/opsAlert";
import { resolveRootOrderId } from "@/lib/replacementOrigin";
import { pickRefundTransaction } from "@/lib/refundTransaction";
import { replacementFundingOf, unitPriceOf } from "@/db/replacementLines";
import { fundingCommand } from "@/lib/settlement/fundingCommand";
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

  // A replacement by explicit identity: created by S2 (its sourceIdentifier
  // names the exchange operation), or named by the census, the reconciliation
  // or `orders.exchange_of` (db/replacementLines.ts). Valued from
  // replacement_lines or not at all — never from tags or by matching variants
  // (S3 R4). A known replacement without funding, or a line the records do
  // not cover, refuses rather than falls back; an order is ordinary only once
  // the census has run and no identity record names it.
  const found = await replacementFundingOf({ id: String(order.id), sourceIdentifier: order.source_identifier });
  if (found.kind === "not-settlement") return { kind: "ordinary" };
  if (found.kind === "unprovable") {
    await alertOps(
      `[returns] ORDER NOT RETURNABLE ONLINE — ${order.name}`,
      `The portal could not establish whether ${order.name} is one of our pre-ledger exchange orders.\n` +
        `Reason: ${found.reason} — the replacement census (scripts/reconcile-legacy.ts --census) must run before this deploy.\n` +
        `The customer was told to contact us. Nothing was saved, so nothing was priced at list.`
    );
    return { kind: "refused", reason: found.reason };
  }
  if (found.kind === "unfunded") {
    return refuseWith(
      order,
      found.sourceOrderId ?? "(unknown)",
      `settlement-order-unfunded:${found.reason}`,
      found.reason === "replacement-without-funding" ? fundingInstructions(String(order.id), found.sourceLines ?? []) : ""
    );
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

/** What the operator runs to record the missing funding (Santi, 30 Oct: A). */
function fundingInstructions(orderId: string, sourceLines: number[]): string {
  if (sourceLines.length === 0) {
    return (
      `\nNo reconciled exchange record names this order yet: resolve its line's unresolved reconciliation ` +
      `operation (scripts/resolve-operation.ts --op <its operation id> --done --order gid://shopify/Order/${orderId} --evidence "<why>" --write) first, then fund it with:\n` +
      fundingCommand(orderId, "<source productsorder id>")
    );
  }
  return (
    `\nRecord the funding from the customer's pre-S1 Stripe payment, once per line:\n` +
    sourceLines.map((po) => fundingCommand(orderId, po)).join("\n")
  );
}

async function refuseWith(order: OrderData, original: string, reason: string, instructions = ""): Promise<ReplacementPlan> {
  await alertOps(
    `[returns] REPLACEMENT ORDER NOT RETURNABLE ONLINE — ${order.name}`,
    `${order.name} is one of our exchange orders (original ${original}) and the portal could not value its lines.\n` +
      `Reason: ${reason}\n` +
      `The customer was told to contact us. Nothing was saved, so nothing was priced at list.` +
      instructions
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
