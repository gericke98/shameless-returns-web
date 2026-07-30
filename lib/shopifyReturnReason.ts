// Pure — maps the reason the customer picked in the portal onto Shopify's
// `ReturnReason` enum for `returnCreate`.
//
// This used to be the literal `COLOR`, hardcoded for every return, so every
// return in Shopify's merchandising reports read "Color" regardless of what the
// customer actually said. Order #310972 is filed as COLOR for a customer who
// chose "Too small".
//
// Enum values below are Shopify's own, introspected from `ReturnReason` on the
// 2025-01 Admin API. A value outside the enum fails the whole mutation, so the
// fallback is deliberately a real member rather than a passthrough.
import type { ReasonKey } from "@/placeholder";

export type ShopifyReturnReason =
  | "SIZE_TOO_SMALL"
  | "SIZE_TOO_LARGE"
  | "UNWANTED"
  | "NOT_AS_DESCRIBED"
  | "WRONG_ITEM"
  | "DEFECTIVE"
  | "STYLE"
  | "COLOR"
  | "OTHER"
  | "UNKNOWN";

const BY_REASON: Record<ReasonKey, ShopifyReturnReason> = {
  TOO_SMALL: "SIZE_TOO_SMALL",
  TOO_BIG: "SIZE_TOO_LARGE",
  DAMAGED: "DEFECTIVE",
  WRONG_ITEM: "WRONG_ITEM",
  NOT_AS_SHOWN: "NOT_AS_DESCRIBED",
  // "I don't like it" is Shopify's STYLE ("the buyer did not like the style").
  DISLIKE: "STYLE",
  // Both are a change of mind rather than a fault with the garment, which is
  // exactly what Shopify's UNWANTED records.
  BOUGHT_OPTIONS: "UNWANTED",
  UNCOMFORTABLE: "UNWANTED",
  // Shopify has no "arrived late" member. OTHER carries a note alongside it.
  LATE: "OTHER",
  OTHER: "OTHER",
};

/**
 * Never returns COLOR unless the customer genuinely chose a colour reason —
 * which the portal cannot currently express, so in practice never. Anything
 * unmapped, missing, or stored as free text degrades to OTHER, which Shopify
 * pairs with a `returnReasonNote` carrying the customer's own words.
 */
export function toShopifyReturnReason(
  reason: string | null | undefined
): ShopifyReturnReason {
  if (!reason) return "OTHER";
  return BY_REASON[reason as ReasonKey] ?? "OTHER";
}
