"use server";

import { getOrderQuery } from "@/db/queries";
import { redirect } from "next/navigation";
import { OrderData, Warning, OrderLineItem } from "@/types";
import {
  extractOrderNoteInfo,
  calculatePriceWithDiscount,
  isWithinReturnPeriod,
  wasItemExchanged,
  wasItemReturned,
} from "@/utils/order-utils";
import { orderExists, saveOrderDetails, saveOrderItem } from "@/db/repository";

/**
 * Processes an order form submission, validates the order details,
 * and saves the order to the database if valid
 *
 * @param prevState Previous state (warning message)
 * @param formData Form data containing order number and email
 * @returns Warning message or redirects to order page
 */
export async function getOrder(
  prevState: Warning,
  formData: FormData
): Promise<Warning> {
  // 1. Validate form input
  const { orderNumber, email } = validateFormInput(formData);
  if (!orderNumber) {
    return { message: "Please enter a valid order number" };
  }

  // 2. Fetch order data
  const order = await getOrderQuery(orderNumber);
  if (!order) {
    return { message: "Please enter a valid order" };
  }

  // 3. Validate order details
  const validationError = validateOrderDetails(order, email);
  if (validationError) {
    return validationError;
  }

  // 4. Check if order exists in database
  const exists = await orderExists(order.id);
  if (exists) {
    // Use redirect directly
    redirect(`/${order.id}`);
  }

  // 5. Save order to database
  await saveOrderToDatabase(order);

  // 6. Use redirect directly
  redirect(`/${order.id}`);
}
/**
 * Validates and extracts form input data
 *
 * @param formData Form data to validate
 * @returns Extracted and cleaned order number and email
 */
function validateFormInput(formData: FormData): {
  orderNumber: string | undefined;
  email: string | undefined;
} {
  const orderNumber = formData.get("order")?.toString().replace(/#/g, "");
  const email = formData.get("email")?.toString();
  return { orderNumber, email };
}

/**
 * Validates order details to ensure it can be processed for returns/exchanges
 *
 * @param order Order data to validate
 * @param email Customer email to verify
 * @returns Warning message if validation fails, null if valid
 */
function validateOrderDetails(
  order: OrderData,
  email?: string
): Warning | null {
  // Validate email
  if (email !== order.contact_email) {
    return { message: "Please enter a valid mail address" };
  }

  // Validate country - only allow Spain/España
  const shippingCountry = order.shipping_address.country?.toLowerCase();
  if (shippingCountry !== "spain" && shippingCountry !== "españa") {
    return {
      message: `For orders outside of mainland Spain, please contact hello@shamelesscollective.com with your order number`,
    };
  }

  // Validate fulfillment status
  if (order.fulfillment_status === null) {
    return {
      message:
        "The order is being prepared. Please contact hello@shamelesscollective.com for any changes",
    };
  }

  // Validate delivery status
  if (
    !order.fulfillments ||
    // order.fulfillments[0]?.shipment_status !== "delivered"
    false
  ) {
    return {
      message:
        "The order is still in transit. Please wait until the order is delivered",
    };
  }

  // Validate delivery date
  const deliveryDate = new Date(order.fulfillments[0].updated_at);
  if (
    !isWithinReturnPeriod(deliveryDate) &&
    order.name !== "#35512" &&
    order.name !== "#35768" &&
    order.name !== "#36617"
  ) {
    return {
      message:
        "Returns and exchanges can only be processed within 60 days of delivery and your order was delivered more than 60 days ago!",
    };
  }

  // Validate order ID
  if (!order.id) {
    return { message: "Invalid order ID" };
  }

  return null;
}

/**
 * Saves order data to the database
 *
 * @param order Order data to save
 */
async function saveOrderToDatabase(order: OrderData): Promise<void> {
  try {
    // 1. Extract exchanged/returned products from order note
    const { exchanges, returns } = extractOrderNoteInfo(order.note || "");

    // 2. Insert order into database
    await saveOrderDetails(order);

    // 3. Process and insert order items
    const orderItems = order.line_items.filter((item) => item.quantity > 0);
    await insertOrderItems(orderItems, order.id, exchanges, returns);
  } catch (error) {
    console.error("Error saving order to database:", error);
    throw new Error("Failed to save order data");
  }
}

/**
 * Inserts order items into the database
 *
 * @param items Line items to insert
 * @param orderId Order ID to associate with items
 * @param exchanges List of exchanged product descriptions
 * @param returns List of returned product descriptions
 */
async function insertOrderItems(
  items: OrderLineItem[],
  orderId: string,
  exchanges: string[],
  returns: string[]
): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      // Check if item was exchanged or returned
      const wasExchanged = wasItemExchanged(item, exchanges);
      const wasReturned = wasItemReturned(item, returns);
      const wasChanged = wasExchanged || wasReturned;

      // Calculate price with discount
      const priceWithDiscount = calculatePriceWithDiscount(item);

      // Insert item into database
      return saveOrderItem(item, orderId, wasChanged, priceWithDiscount);
    })
  );
}
