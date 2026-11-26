// Which replacement garments the portal offers (F1 spec §3).
//
// ONE predicate, used by both sides: the exchange dialog decides what it lets
// the customer pick with it (app/[id]/components/dialogForm.tsx, over the
// catalogue `getProducts()` reads), and the server refuses any other choice
// with it (lib/server/orderScope.ts `setLineSelection`, over the variant read
// back from Shopify). So a variant the dialog would never show cannot be saved
// by calling the action directly.
//
// The policy is exactly what the dialog offered before it was written down:
// `getProducts()` lists only ACTIVE products, and a size is selectable only
// while it has stock. Any product counts, not only the one being returned:
// cross-product exchanges are a feature.
//
// Pure, so client components can import it.

export type OfferableVariant = {
  /** The variant's product status in Shopify ("ACTIVE", "DRAFT", "ARCHIVED"). */
  productStatus: string | null | undefined;
  inventoryQuantity: number | null | undefined;
};

export function isOfferedReplacement(variant: OfferableVariant): boolean {
  return (
    variant.productStatus === "ACTIVE" &&
    typeof variant.inventoryQuantity === "number" &&
    variant.inventoryQuantity > 0
  );
}
