// What a replacement garment costs the customer.
//
// Pure — no db, no env, no network — so it is unit-testable and safe to import
// from a client component. The server-only wrapper is lib/loadBasket.ts.
//
// This replaces `applyGlobalDiscount`, which derived ONE discount ratio from
// `order.products[0]` and rewrote the whole catalogue with it. That made a
// replacement's price a property of the catalogue rather than of the pairing
// it belongs to, so every line after the first was mispriced whenever an order
// carried different markdown depths. Order #311749 paid 22.3% off one garment
// and 31.8% off another and was asked for EUR 6.60 to change both sizes.
import { variantGid } from "@/lib/shopifyIds";
import type { Product } from "@/types";

/**
 * How a price was arrived at.
 *
 * - `paid`   the line's own paid price, verbatim. Same-product size swaps.
 * - `ratio`  the line's own discount depth applied to a different garment.
 * - `median` the order's median depth, because this line's original variant
 *            has left the catalogue.
 * - `none`   list price: nothing in the order resolved. Degraded.
 *
 * `median` and `none` are degraded. This module cannot alert — alertOps is a
 * server action — so it reports the basis and the server-side caller decides.
 */
export type PricingBasis = "paid" | "ratio" | "median" | "none";

export type PricedResult = { price: number; basis: PricingBasis };

/** The fields of a productsorder row this module needs. */
export type PricedLine = {
  productId: string;
  variant_id: string;
  new_variant_id: string | null;
  price: string;
};

export type CatalogueIndex = {
  priceOf(variantId: string | null | undefined): number | null;
  /** The BARE product id owning a variant, to compare against `productId`. */
  productOf(variantId: string | null | undefined): string | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Normalise a variant id to one comparable key.
 *
 * `productsorder.variant_id` is bare, `new_variant_id` and the catalogue are
 * GIDs, so the two real shapes must collapse to the same string. Anything
 * variantGid() refuses is compared verbatim instead of being dropped: an id
 * shape we do not recognise should still match itself.
 */
export const variantKey = (
  id: string | number | null | undefined
): string | null => {
  const raw = String(id ?? "").trim();
  if (!raw) return null;
  return variantGid(raw) ?? raw;
};

export function indexCatalogue(catalogue: Product[]): CatalogueIndex {
  const price = new Map<string, number>();
  const owner = new Map<string, string>();

  // Both build and lookup key through variantKey(). db/queries.ts happens
  // to always hand back GIDs today, so building the map from raw
  // edge.node.id looked safe — but a catalogue entry that ever arrived
  // bare would build a key the normalised lookup below can never match,
  // silently falling through to the "paid" basis: a free exchange with no
  // error. A variant whose id doesn't normalise to anything is skipped
  // rather than indexed under a key nothing can ever look up again.
  for (const product of catalogue) {
    const bareProductId = product.id.split("/").pop() ?? "";
    for (const edge of product.variants.edges) {
      const variantKeyForEdge = variantKey(edge.node.id);
      if (variantKeyForEdge === null) continue;
      const parsed = parseFloat(edge.node.price);
      if (Number.isFinite(parsed)) price.set(variantKeyForEdge, parsed);
      owner.set(variantKeyForEdge, bareProductId);
    }
  }

  // Keys are normalised via variantKey(). Callers may hand us either shape,
  // so normalise on the way in too: `productsorder.variant_id` is bare
  // while `new_variant_id` is a GID, and comparing the two shapes directly
  // is how this silently returns null for every original variant in the
  // system.
  const key = (id: string | null | undefined) => variantKey(id);

  return {
    priceOf: (id) => {
      const k = key(id);
      return k === null ? null : price.get(k) ?? null;
    },
    productOf: (id) => {
      const k = key(id);
      return k === null ? null : owner.get(k) ?? null;
    },
  };
}

/**
 * How much less than today's list price this line was paid, as a factor in
 * (0, 1]. Null when the original variant is no longer in the catalogue.
 *
 * Clamped at 1: a ratio above 1 means the garment has been marked down below
 * what the customer paid, and multiplying a replacement's list price by it
 * would charge more than the replacement is worth.
 */
export function lineRatio(
  line: PricedLine,
  index: CatalogueIndex
): number | null {
  const paid = parseFloat(line.price);
  const listNow = index.priceOf(line.variant_id);
  if (!Number.isFinite(paid) || listNow === null || listNow <= 0) return null;
  const ratio = paid / listNow;
  if (!(ratio > 0)) return null;
  return Math.min(1, ratio);
}

/**
 * The order's median discount depth, for lines whose own original variant has
 * left the catalogue. Median rather than mean so one archived oddity cannot
 * drag the whole order's pricing.
 */
export function orderRatio(
  lines: PricedLine[],
  index: CatalogueIndex
): number | null {
  const ratios = lines
    .map((line) => lineRatio(line, index))
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);

  if (ratios.length === 0) return null;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 1
    ? ratios[mid]
    : (ratios[mid - 1] + ratios[mid]) / 2;
}

/**
 * Price `newVariantId` as a replacement for `line`.
 *
 * A same-product swap short-circuits to the paid price before any catalogue
 * arithmetic happens. That is the whole fix: a customer changing size cannot
 * be charged, whatever the catalogue has done since they ordered.
 */
export function replacementPriceForVariant(
  line: PricedLine,
  newVariantId: string | null,
  index: CatalogueIndex,
  fallbackRatio: number | null
): PricedResult {
  const paid = round2(parseFloat(line.price) || 0);

  if (!newVariantId) return { price: paid, basis: "paid" };

  const newOwner = index.productOf(newVariantId);
  if (newOwner !== null && newOwner === String(line.productId)) {
    return { price: paid, basis: "paid" };
  }

  const listNow = index.priceOf(newVariantId);
  // We cannot price what we cannot find. Falling back to the paid price keeps
  // the basket at zero rather than inventing a charge from nothing.
  if (listNow === null) return { price: paid, basis: "paid" };

  const own = lineRatio(line, index);
  if (own !== null) return { price: round2(listNow * own), basis: "ratio" };

  if (fallbackRatio !== null) {
    return { price: round2(listNow * fallbackRatio), basis: "median" };
  }

  return { price: round2(listNow), basis: "none" };
}

/** Price the replacement this line has already chosen. */
export function replacementPrice(
  line: PricedLine,
  index: CatalogueIndex,
  fallbackRatio: number | null
): PricedResult {
  return replacementPriceForVariant(
    line,
    line.new_variant_id,
    index,
    fallbackRatio
  );
}
