// Server-only wrapper around lib/basket.ts. Separate file because importing
// db/queries.ts pulls in the Shopify Node adapter and the Neon client, which
// must not be dragged into unit tests or client bundles.
import { getOrderById, getProducts } from "@/db/queries";
import { valueBasket } from "@/lib/basket";
import type { OrderItem } from "@/types";

/** Load an order and value its basket. Returns null if the order is gone. */
export async function loadBasket(orderId: string) {
  const order = await getOrderById(orderId);
  if (!order) return null;

  // The catalogue is passed through RAW. Replacement prices are derived per
  // line by lib/replacementPricing.ts, so nothing here rewrites a price.
  const catalogue = await getProducts();
  const basket = valueBasket(order.products as OrderItem[], catalogue);

  return { order, catalogue, basket };
}
