// Basket valuation. The client computes the same numbers for display; the
// server uses these to derive the *charge*, so the browser can no longer
// decide how much it pays.
//
// Pure module: no db, no env, no server-only imports, so it is unit-testable
// and safe to import from anywhere. The DB-backed wrapper is lib/loadBasket.ts.
import type { OrderItem, Product, ProductVariant } from "@/types";
import {
  indexCatalogue,
  orderRatio,
  replacementPrice,
  variantKey,
  type PricedLine,
} from "@/lib/replacementPricing";

/**
 * Weight a variant contributes when the catalogue does not say.
 *
 * Reachable for a variant genuinely absent from the catalogue — deleted or
 * archived in Shopify since the order was placed. Zero would be the
 * dangerous default: it makes a parcel look lighter than it is and drops it
 * into a cheaper band, so an unknown item would *reduce* the fee. It sits
 * between the catalogue's median (423g) and p75 (550g).
 *
 * Until 2026-09-01 this was reachable for EVERY item, not just genuinely
 * missing ones: `parcelGrams` keyed its lookup by GID but read it with the
 * bare `variant_id` `productsorder` stores, so the lookup missed for every
 * item and every parcel was weighed at this fallback regardless of the
 * catalogue.
 */
export const FALLBACK_ITEM_GRAMS = 500;

/**
 * Weight of the parcel the customer ships back, in grams.
 *
 * The parcel holds the items being sent back — the ORIGINAL variants — even
 * for an exchange, where the replacement travels separately in the other
 * direction and is not part of this shipment.
 *
 * Unlike the price sums below, this multiplies by quantity: two units of a
 * garment genuinely weigh twice as much, whatever the line's price represents.
 */
export function parcelGrams(
  items: OrderItem[],
  discountedProducts: Product[]
): number {
  const byVariantId = new Map<string, ProductVariant>();
  for (const product of discountedProducts) {
    for (const edge of product.variants.edges) {
      const key = variantKey(edge.node.id);
      if (key) byVariantId.set(key, edge.node);
    }
  }

  return items.reduce((sum, item) => {
    const key = variantKey(item.variant_id);
    const variant = key ? byVariantId.get(key) : undefined;
    const grams = variant?.grams ?? FALLBACK_ITEM_GRAMS;
    const quantity = Math.max(1, Number(item.quantity) || 1);
    return sum + grams * quantity;
  }, 0);
}

/**
 * Value a basket the same way every client component does: everything with an
 * action counts toward the return total; CAMBIO lines subtract the price of
 * their replacement.
 *
 * `discountedProducts` used to arrive pre-mutated by `applyGlobalDiscount`.
 * It now arrives RAW, and each replacement is priced against the line it
 * replaces — see lib/replacementPricing.ts for why.
 */
export function valueBasket(
  items: OrderItem[],
  catalogue: Product[]
): {
  returnPrice: number;
  exchangePrice: number;
  netAmount: number;
  hasItems: boolean;
  grams: number;
  degraded: boolean;
} {
  const active = items.filter((item) => item.action && !item.confirmed);
  const index = indexCatalogue(catalogue);
  const fallbackRatio = orderRatio(items as unknown as PricedLine[], index);

  const returnPrice = active.reduce(
    (sum, item) => sum + parseFloat(item.price),
    0
  );

  let degraded = false;
  const exchangePrice = active
    .filter((item) => item.action === "CAMBIO")
    .reduce((sum, item) => {
      const priced = replacementPrice(
        item as unknown as PricedLine,
        index,
        fallbackRatio
      );
      // The server-side caller alerts on this; a pure module cannot.
      if (priced.basis === "median" || priced.basis === "none") degraded = true;
      return sum + priced.price;
    }, 0);

  return {
    returnPrice,
    exchangePrice,
    netAmount: returnPrice - exchangePrice,
    hasItems: active.length > 0,
    grams: parcelGrams(active, catalogue),
    degraded,
  };
}
