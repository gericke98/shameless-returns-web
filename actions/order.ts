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
import { isInternationalOrder } from "@/actions/amphoraReturn";
import { normalizeCountry } from "@/lib/countries";
import { issueOrderAccess } from "@/lib/orderAccess";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, dictionaries, readLocale } from "@/lib/i18n";
import { clientIpFrom, exceedsLookupLimit } from "@/lib/rateLimit";
import {
  countRecentFailures,
  recordFailedAttempt,
} from "@/db/lookupAttempts";

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

  // Rate limit. Since /[id] requires a portal session, this lookup is the only
  // door — and it is an order number plus a matching email, so someone holding a
  // customer's email could brute-force sequential Shopify order numbers.
  //
  // A null ip means the caller could not be attributed; allow the attempt rather
  // than bucketing every unattributable request together, which would let one
  // attacker lock out everybody else who lands in that bucket.
  const now = Date.now();
  const ip = clientIpFrom({
    "x-real-ip": headers().get("x-real-ip"),
    "x-vercel-forwarded-for": headers().get("x-vercel-forwarded-for"),
    "x-forwarded-for": headers().get("x-forwarded-for"),
  });

  if (ip && exceedsLookupLimit(await countRecentFailures(ip, now))) {
    const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
    // Deliberately vague: it must not hint whether any attempted order number
    // exists.
    return { message: dictionaries[locale].lookup.tooManyAttempts };
  }

  // 2. Fetch order data
  const order = await getOrderQuery(orderNumber);
  if (!order) {
    // A wrong order number is a guessing signal — count it.
    if (ip) await recordFailedAttempt(ip, now);
    return { message: "Please enter a valid order" };
  }

  // 3. Validate order details
  const validationError = validateOrderDetails(order, email);
  if (validationError) {
    // So is a real order number with the wrong email — in fact more so, since it
    // means the order number was guessed correctly.
    if (ip) await recordFailedAttempt(ip, now);
    return validationError;
  }

  // 4. Check if order exists in database
  const exists = await orderExists(order.id);
  if (exists) {
    // The order number and contact email have now been checked, so record that
    // proof before handing the customer a URL that depends on it. redirect()
    // throws by design, so this must come first.
    //
    // String(): `order` came from getOrderQuery, which returns untyped JSON.
    // Shopify sends `id` as a number despite OrderData declaring `string`, and
    // the session has to match `params.id` from the URL. See lib/orderSession.ts.
    await issueOrderAccess(String(order.id));
    redirect(`/${order.id}`);
  }

  // 5. Save order to database
  await saveOrderToDatabase(order);

  // 6. Same as the exists branch above: issue the session before redirecting,
  // and String() the Shopify-supplied id for the same reason.
  await issueOrderAccess(String(order.id));
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

  // Validate country. Spain is always allowed (national Correos). Everything
  // else is allowed only when Amphora international returns are enabled, which
  // covers EU and non-EU alike; with the flag off, those customers get the
  // contact message rather than a return they cannot ship.
  //
  // There was a third case here for an EU-only Sendcloud lane. Removing it
  // narrows nothing: Amphora already covers every country it did.
  const rawCountry = order.shipping_address.country;
  const isSpain = normalizeCountry(rawCountry) === "ES";
  const isAmphoraIntl =
    isInternationalOrder(rawCountry) &&
    process.env.AMPHORA_INTL_RETURNS_ENABLED === "true";
  if (!isSpain && !isAmphoraIntl) {
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
