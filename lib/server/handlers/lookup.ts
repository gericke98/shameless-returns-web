import "server-only";
// The order lookup (F1 spec §4 `lookupOrder`): the portal's only public write.
// Wrapped by `publicFormAction` in actions/order.ts. The order number and the
// contact email are matched against Shopify (rate limit first); only then is
// the order's id minted (`verifiedByLookup`, this file is its only caller),
// saved, and the portal session issued for it.
//
// Its answers are i18n keys (`MessageKey`), never text: the browser renders
// them in the customer's language.
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { getOrderQuery } from "@/db/queries";
import { OrderData, OrderLineItem } from "@/types";
import {
  extractOrderNoteInfo,
  calculatePriceWithDiscount,
  isWithinReturnPeriod,
  wasItemExchanged,
  wasItemReturned,
} from "@/utils/order-utils";
import { orderExists, saveOrderDetails, saveOrderItem } from "@/db/repository";
import { planReplacementOrder, type ReplacementPlan } from "@/lib/server/replacementOrder";
import { isInternationalOrder } from "@/lib/server/amphoraReturn";
import { normalizeCountry } from "@/lib/countries";
import { issueOrderAccess } from "@/lib/orderAccess";
import type { MessageKey } from "@/lib/i18n";
import { clientIpFrom, exceedsLookupLimit } from "@/lib/rateLimit";
import { countRecentFailures, recordFailedAttempt } from "@/db/lookupAttempts";
import type { PublicContext } from "@/lib/server/actions";
import { verifiedByLookup, type VerifiedOrderId } from "@/lib/server/identity";

/** The lookup form's state: an i18n key, or nothing to show. */
export type LookupState = { message: MessageKey | null };

export const lookupOrderInput = z
  .object({
    // Field names as the form has always sent them.
    order: z.string().max(64),
    email: z.string().max(320),
  })
  .strict();

const answer = (message: MessageKey): LookupState => ({ message });

export async function lookupOrderHandler(
  _ctx: PublicContext,
  input: z.infer<typeof lookupOrderInput>,
  _prevState: LookupState
): Promise<LookupState> {
  const orderNumber = input.order.replace(/#/g, "");
  if (!orderNumber) return answer("lookup.invalidInput");
  const email = input.email;

  const now = Date.now();
  const ip = clientIpFrom({
    "x-real-ip": headers().get("x-real-ip"),
    "x-vercel-forwarded-for": headers().get("x-vercel-forwarded-for"),
    "x-forwarded-for": headers().get("x-forwarded-for"),
  });

  if (ip && exceedsLookupLimit(await countRecentFailures(ip, now))) {
    return answer("lookup.tooManyAttempts");
  }

  const order = await getOrderQuery(orderNumber);
  if (!order) {
    if (ip) await recordFailedAttempt(ip, now);
    return answer("lookup.notFound");
  }

  const refusal = validateOrderDetails(order, email);
  if (refusal) {
    if (ip) await recordFailedAttempt(ip, now);
    return answer(refusal);
  }

  // The number and the email matched Shopify's order: this is the credential.
  const id = verifiedByLookup(order);

  if (await orderExists(id)) {
    await issueOrderAccess(id);
    redirect(`/${id}`);
  }

  const replacement = await planReplacementOrder(order);
  if (replacement.kind === "refused") return answer("lookup.contactSupport");
  await saveOrderToDatabase(id, order, replacement);

  await issueOrderAccess(id);
  redirect(`/${id}`);
}

function validateOrderDetails(order: OrderData, email?: string): MessageKey | null {
  // Validate email
  if (email !== order.contact_email) {
    return "lookup.mismatch";
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
    return "lookup.contactSupport";
  }

  // Validate fulfillment status
  if (order.fulfillment_status === null) {
    return "lookup.notYetShipped";
  }

  // Validate delivery status
  if (
    !order.fulfillments ||
    // order.fulfillments[0]?.shipment_status !== "delivered"
    false
  ) {
    return "lookup.notYetShipped";
  }

  // Validate delivery date
  const deliveryDate = new Date(order.fulfillments[0].updated_at);
  if (
    !isWithinReturnPeriod(deliveryDate) &&
    order.name !== "#35512" &&
    order.name !== "#35768" &&
    order.name !== "#36617"
  ) {
    return "lookup.outsideWindow";
  }

  // Validate order ID
  if (!order.id) {
    return "lookup.notFound";
  }

  return null;
}

/**
 * Saves order data to the database
 *
 * @param order Order data to save
 */
async function saveOrderToDatabase(
  id: VerifiedOrderId,
  order: OrderData,
  replacement: ReplacementPlan
): Promise<void> {
  try {
    // 1. Extract exchanged/returned products from order note
    const { exchanges, returns } = extractOrderNoteInfo(order.note || "");

    // 2. Insert order into database
    await saveOrderDetails(
      id,
      order,
      replacement.kind === "replacement" ? replacement.exchangeOf : null
    );

    // 3. Process and insert order items
    const orderItems = order.line_items.filter((item) => item.quantity > 0);
    await insertOrderItems(orderItems, id, exchanges, returns, replacement);
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
  orderId: VerifiedOrderId,
  exchanges: string[],
  returns: string[],
  replacement: ReplacementPlan
): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      // Check if item was exchanged or returned
      const wasExchanged = wasItemExchanged(item, exchanges);
      const wasReturned = wasItemReturned(item, returns);
      const wasChanged = wasExchanged || wasReturned;

      // A replacement order's own prices are list prices; the customer paid
      // what the original's exchange row says. planReplacementOrder already
      // guaranteed every line has one, so there is no fallback here.
      const priceWithDiscount =
        replacement.kind === "replacement"
          ? Number(replacement.priceByLineItem[String(item.id)])
          : calculatePriceWithDiscount(item);

      // Insert item into database
      return saveOrderItem(item, orderId, wasChanged, priceWithDiscount);
    })
  );
}
