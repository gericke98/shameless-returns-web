// Which replacement garments the portal offers (F1 spec §3; FX §#1).
//
// ONE predicate, used by both sides: the exchange dialog decides what it lets
// the customer pick with it (app/[id]/components/dialogForm.tsx, over the
// catalogue `getProducts()` reads), and the server refuses any other choice
// with it (lib/server/orderScope.ts `setLineSelection`, over the variant read
// back from Shopify). So a variant the dialog would never show cannot be saved
// by calling the action directly.
//
// The offer rule is the product's status only: an ACTIVE product. Any product
// counts, not only the one being returned: cross-product exchanges are a
// feature. Whether a size can be SHIPPED is not an offer rule: Amphora's stock
// decides it on the server (lib/server/amphoraStock.ts, at save and submit),
// and Shopify's `inventoryQuantity` is a display hint for the picker only
// (FX decision 2).
//
// Pure, so client components can import it.

export type OfferableProduct = {
  /** The variant's product status in Shopify ("ACTIVE", "DRAFT", "ARCHIVED"). */
  productStatus: string | null | undefined;
};

export function isOfferedProduct(variant: OfferableProduct): boolean {
  return variant.productStatus === "ACTIVE";
}
