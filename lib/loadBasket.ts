// Server-only wrapper around lib/basket.ts. Separate file because importing
// db/queries.ts pulls in the Shopify Node adapter and the Neon client, which
// must not be dragged into unit tests or client bundles.
import { getOrderById, getProducts } from "@/db/queries";
import { applyGlobalDiscount, valueBasket } from "@/lib/basket";
import type { OrderItem } from "@/types";

/** Load an order and value its basket. Returns null if the order is gone. */
export async function loadBasket(orderId: string) {
  const order = await getOrderById(orderId);
  if (!order) return null;

  const allProducts = await getProducts();
  const discountedProducts = applyGlobalDiscount(allProducts, order.products[0]);
  const basket = valueBasket(order.products as OrderItem[], discountedProducts);

  return { order, discountedProducts, basket };
}
