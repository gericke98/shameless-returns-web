"use server";

import db from "@/db/drizzle";
import { orders, productsOrder } from "@/db/schema";
import { OrderData, LineItem } from "@/types";
import { eq, and } from "drizzle-orm";
import { formatOrderId } from "@/utils/order-utils";

/**
 * Checks if an order exists in the database
 *
 * @param orderId Order ID to check
 * @returns Boolean indicating if the order exists
 */
export async function orderExists(orderId: string): Promise<boolean> {
  const orderDB = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
  });

  return !!orderDB;
}

/**
 * Saves order details to the database
 *
 * @param order Order data to save
 */
export async function saveOrderDetails(order: OrderData): Promise<void> {
  await db.insert(orders).values({
    id: formatOrderId(order.id),
    orderNumber: order.name,
    subtotal: Math.round(Number(order.subtotal_price) * 100) || 0,
    email: order.contact_email,
    shippingName: order.shipping_address.name,
    shippingAddress1: order.shipping_address.address1,
    shippingAddress2: order.shipping_address.address2 || "",
    shippingZip: order.shipping_address.zip,
    shippingCity: order.shipping_address.city,
    shippingProvince: order.shipping_address.province,
    shippingCountry: order.shipping_address.country,
    shippingPhone: order.shipping_address.phone || "",
  });
}

/**
 * Saves order items to the database
 *
 * @param item Line item to save
 * @param orderId Order ID to associate with the item
 * @param wasChanged Whether the item was changed
 * @param priceWithDiscount Price with discount applied
 */
export async function saveOrderItem(
  item: LineItem,
  orderId: string,
  wasChanged: boolean,
  priceWithDiscount: number
): Promise<void> {
  await db.insert(productsOrder).values({
    lineItemId: formatOrderId(item.id),
    orderId: formatOrderId(orderId),
    productId: formatOrderId(item.product_id),
    title: item.title,
    variant_title: item.variant_title || "",
    variant_id: formatOrderId(item.variant_id),
    price: priceWithDiscount.toString(),
    quantity: item.quantity,
    changed: false,
    confirmed: wasChanged,
    credit: false,
    gift_card_id: null,
  });
}

/**
 * Gets an order by ID
 *
 * @param orderId Order ID to get
 * @returns Order data or null if not found
 */
export async function getOrderById(orderId: string) {
  return db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    with: {
      products: true,
    },
  });
}

/**
 * Gets order products by order ID
 *
 * @param orderId Order ID to get products for
 * @returns Array of order products
 */
export async function getOrderProductsById(orderId: string) {
  return db.query.productsOrder.findMany({
    where: eq(productsOrder.orderId, orderId),
  });
}

/**
 * Updates an order product
 *
 * @param variantId Variant ID of the product to update
 * @param orderId Order ID of the product to update
 * @param updates Updates to apply to the product
 */
export async function updateOrderProduct(
  variantId: string,
  orderId: string,
  updates: Partial<typeof productsOrder.$inferInsert>
) {
  return db
    .update(productsOrder)
    .set(updates)
    .where(
      and(
        eq(productsOrder.variant_id, variantId),
        eq(productsOrder.orderId, orderId)
      )
    );
}
