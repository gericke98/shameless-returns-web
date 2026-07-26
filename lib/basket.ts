// Basket valuation. The client computes the same numbers for display; the
// server uses these to derive the *charge*, so the browser can no longer
// decide how much it pays.
//
// The discount math here is lifted verbatim from app/[id]/page.tsx so the two
// cannot drift — page.tsx now calls applyGlobalDiscount rather than inlining it.
//
// Pure module: no db, no env, no server-only imports, so it is unit-testable
// and safe to import from anywhere. The DB-backed wrapper is lib/loadBasket.ts.
import type { OrderItem, Product, ProductVariant } from "@/types";

/**
 * Shopify returns current catalogue prices, but the customer paid the price at
 * order time. Derive a single ratio from the order's first line and apply it to
 * every variant, so replacement items are priced at what the customer would
 * effectively have paid.
 */
export function applyGlobalDiscount(
  allProducts: Product[],
  firstOrderProduct: { productId: string | number; price: string } | undefined
): Product[] {
  let globalDiscountRatio = 1;

  if (firstOrderProduct) {
    const firstProductId = firstOrderProduct.productId.toString();
    const firstCurrentProduct = allProducts.find(
      (p: Product) => p.id.split("/").pop() === firstProductId
    );
    if (firstCurrentProduct) {
      const orderPrice = parseFloat(firstOrderProduct.price);
      const currentPrice = parseFloat(
        firstCurrentProduct.variants.edges[0].node.price
      );
      if (currentPrice > 0) {
        globalDiscountRatio = orderPrice / currentPrice;
      }
    }
  }

  return allProducts.map((product: Product) => ({
    ...product,
    variants: {
      ...product.variants,
      edges: product.variants.edges.map((edge: { node: ProductVariant }) => ({
        ...edge,
        node: {
          ...edge.node,
          price: (parseFloat(edge.node.price) * globalDiscountRatio).toFixed(2),
        },
      })),
    },
  }));
}

/**
 * Value a basket the same way every client component does: everything with an
 * action counts toward the return total; CAMBIO lines subtract the price of
 * their replacement variant (falling back to the original price when the
 * variant cannot be found).
 */
export function valueBasket(
  items: OrderItem[],
  discountedProducts: Product[]
): {
  returnPrice: number;
  exchangePrice: number;
  netAmount: number;
  hasItems: boolean;
} {
  const active = items.filter((item) => item.action && !item.confirmed);

  const returnPrice = active.reduce(
    (sum, item) => sum + parseFloat(item.price),
    0
  );

  const exchangePrice = active
    .filter((item) => item.action === "CAMBIO")
    .reduce((sum, item) => {
      if (item.new_variant_id) {
        const newProduct = discountedProducts.find((p) =>
          p.variants.edges.some((v) => v.node.id === item.new_variant_id)
        );
        const newVariant = newProduct?.variants.edges.find(
          (v) => v.node.id === item.new_variant_id
        );
        if (newVariant) return sum + parseFloat(newVariant.node.price);
      }
      return sum + parseFloat(item.price);
    }, 0);

  return {
    returnPrice,
    exchangePrice,
    netAmount: returnPrice - exchangePrice,
    hasItems: active.length > 0,
  };
}
