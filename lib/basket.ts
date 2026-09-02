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
  round2,
  variantKey,
  type PricedLine,
} from "@/lib/replacementPricing";

/**
 * Weight a variant contributes when the catalogue does not say.
 *
 * Reachable for a variant genuinely absent from the catalogue AS
 * `db/queries.ts`'s `getProducts()` READS IT — it filters Shopify to
 * `query: "status:ACTIVE"`, so a product merely set to DRAFT (46 of this
 * store's 83, as of 2026-09-01) is invisible here exactly like one actually
 * deleted or archived. Zero would be the dangerous default: it makes a parcel
 * look lighter than it is and drops it into a cheaper band, so an unknown
 * item would *reduce* the fee. It sits between the catalogue's median (423g)
 * and p75 (550g).
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
  catalogue: Product[]
): number {
  const byVariantId = new Map<string, ProductVariant>();
  for (const product of catalogue) {
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
 * `catalogue` used to arrive pre-mutated by `applyGlobalDiscount`. It now
 * arrives RAW, and each replacement is priced against the line it replaces —
 * see lib/replacementPricing.ts for why.
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

  // Rounded per line, to cents, exactly like exchangePrice below already is —
  // `item.price` comes from calculatePriceWithDiscount's unrounded
  // `unit - allocated/quantity` (utils/order-utils.ts) stored verbatim
  // (db/repository.ts), so a qty>=3 line with a non-divisible allocation
  // lands here as e.g. 50.88333333333333. Summing that raw against
  // exchangePrice's already-rounded 50.88 left a same-product swap with
  // netAmount = +0.0033... instead of exactly 0, which flipped resolveFee
  // from the exchange lane to the return lane — undercharging the outbound
  // leg entirely. Rounding here, at the same single point exchangePrice
  // already rounds at, keeps both sums at the same cents-precision so their
  // difference is exact; it deliberately does NOT round at the source
  // (calculatePriceWithDiscount), which would drift a line's own total (3 x
  // 50.88 = 152.64, not the 152.65 the unrounded per-unit price sums to).
  const returnPrice = active.reduce(
    (sum, item) => sum + round2(parseFloat(item.price)),
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
      // The server-side caller (createStripeUrl, actions/payments.ts) alerts
      // on this; a pure module cannot.
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
