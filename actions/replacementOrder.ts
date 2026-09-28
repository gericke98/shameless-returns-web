// Server-only. Decides, at first portal lookup, whether an order is one of our
// replacement orders and what its lines are really worth. The rules are pure
// and live in lib/replacementOrigin.ts; this file only loads the original.
import { getOrderByNumberFresh } from "@/db/queries";
import { alertOps } from "@/actions/opsAlert";
import {
  originalOrderNumberFromTags,
  planReplacementPricing,
  type OriginalRow,
} from "@/lib/replacementOrigin";
import type { OrderData } from "@/types";

export type ReplacementPlan =
  | { kind: "ordinary" }
  | { kind: "replacement"; exchangeOf: string; priceByVariant: Record<string, string> }
  | { kind: "refused"; reason: string };

export async function planReplacementOrder(order: OrderData): Promise<ReplacementPlan> {
  const originalNumber = originalOrderNumberFromTags(order.tags);
  if (!originalNumber) return { kind: "ordinary" };

  const refuse = async (reason: string): Promise<ReplacementPlan> => {
    await alertOps(
      `[returns] REPLACEMENT ORDER NOT RETURNABLE ONLINE — ${order.name}`,
      `${order.name} is one of our exchange orders (original ${originalNumber}) and the portal could not value its lines.\n` +
        `Reason: ${reason}\n` +
        `The customer was told to contact us. Nothing was saved, so nothing was priced at list.`
    );
    return { kind: "refused", reason };
  };

  const original = await getOrderByNumberFresh(originalNumber);
  if (!original) return refuse(`original-not-found:${originalNumber}`);

  const lines = order.line_items
    .filter((item) => item.quantity > 0)
    .map((item) => ({ variant_id: item.variant_id, product_id: item.product_id }));
  const plan = planReplacementPricing(
    lines,
    ((original as any).products ?? []) as OriginalRow[]
  );
  if (!plan.ok) return refuse(plan.reason);

  return {
    kind: "replacement",
    exchangeOf: String(original.id),
    priceByVariant: plan.priceByVariant,
  };
}
