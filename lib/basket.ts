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
  /** netAmount in integer cents — the value money decisions must use. */
  netCents: number;
  lines: ValuedLine[];
  hasItems: boolean;
  grams: number;
  degraded: boolean;
} {
  const active = items.filter((item) => item.action && !item.confirmed);
  const index = indexCatalogue(catalogue);
  const fallbackRatio = orderRatio(items as unknown as PricedLine[], index);

  let degraded = false;
  const lines = active.map((item) => {
    const valued = valueLine(item, index, fallbackRatio);
    // The server-side caller (createStripeUrl, actions/payments.ts) alerts
    // on this; a pure module cannot.
    if (valued.degraded) degraded = true;
    return valued;
  });

  // Summed in integer cents, converted once. Every line is already exact
  // cents (see valueLine), so a same-product swap nets to exactly 0 — the
  // property the old per-unit round2 existed to protect.
  const returnedCents = lines.reduce((sum, line) => sum + line.returnedCents, 0);
  const replacementCents = lines.reduce(
    (sum, line) => sum + line.replacementCents,
    0
  );

  return {
    returnPrice: returnedCents / 100,
    exchangePrice: replacementCents / 100,
    netAmount: (returnedCents - replacementCents) / 100,
    netCents: returnedCents - replacementCents,
    lines,
    hasItems: active.length > 0,
    grams: parcelGrams(active, catalogue),
    degraded,
  };
}

/** One basket line, valued in integer cents. */
export type ValuedLine = {
  /** `productsorder.id`, the line's stable identity. */
  readonly id: number;
  readonly action: string;
  readonly quantity: number;
  /** What this line is worth coming back: its whole line total. */
  readonly returnedCents: number;
  /** What its replacement costs, whole line; 0 unless CAMBIO. */
  readonly replacementCents: number;
  readonly degraded: boolean;
};

/**
 * Value one line as LINE TOTALS, not unit prices — Shopify is sent `quantity`,
 * so a qty-2 line returns two garments and has to be worth two.
 *
 * `item.price` is the unrounded per-unit price `calculatePriceWithDiscount`
 * stores (utils/order-utils.ts: `unit - allocated/quantity`), e.g.
 * 50.88333… for a qty-3 line. The line total is rounded ONCE, from that
 * unrounded price: 3 × 50.88333… = 152.65, which is what the customer paid —
 * rounding the unit first and multiplying would give 152.64.
 *
 * A same-product swap reuses the returned total exactly, so the line nets to
 * 0 whatever the rounding; that is what keeps resolveFee in the exchange lane
 * for a size change. Any other replacement is priced per unit in whole cents
 * (replacementPriceForVariant already rounds it) and multiplied, which is
 * exact.
 */
export function valueLine(
  item: OrderItem,
  index: ReturnType<typeof indexCatalogue>,
  fallbackRatio: number | null
): ValuedLine {
  const quantity = Math.max(1, Number(item.quantity) || 1);
  const returnedCents = Math.round((parseFloat(item.price) || 0) * quantity * 100);
  if (item.action !== "CAMBIO") {
    return {
      id: Number((item as any).id),
      action: String(item.action),
      quantity,
      returnedCents,
      replacementCents: 0,
      degraded: false,
    };
  }
  const priced = replacementPrice(
    item as unknown as PricedLine,
    index,
    fallbackRatio
  );
  const replacementCents =
    priced.basis === "paid"
      ? returnedCents
      : Math.round(round2(priced.price) * 100) * quantity;
  return {
    id: Number((item as any).id),
    action: "CAMBIO",
    quantity,
    returnedCents,
    replacementCents,
    degraded: priced.basis === "median" || priced.basis === "none",
  };
}
