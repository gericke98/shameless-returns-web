"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { LOCALE_COOKIE, readLocale } from "@/lib/i18n";
import { createShippingLabel } from "./shipping";
import { updateFinalOrder } from "./updateOrder";
import { createStripeUrl } from "./payments";
import { getOrderById } from "@/db/queries";
import { hasOrderAccess } from "@/lib/orderAccess";
import { createInternationalReturn, isInternationalOrder } from "./amphoraReturn";
import { createSendcloudReturn, euIso2ForReturn } from "./sendcloudReturn";

/**
 * Route the physical return, in priority order:
 *  1. EU (non-ES) → Sendcloud pre-paid drop-off label (gated by
 *     SENDCLOUD_INTL_RETURNS_ENABLED).
 *  2. Any other international → Amphora collection (gated by
 *     AMPHORA_INTL_RETURNS_ENABLED).
 *  3. Spain, or any flag-off case → Correos label (unchanged).
 * Returns an HTTP-style status (200 = success) in every case. With both flags
 * off this is behaviour-identical to the Correos-only flow.
 */
async function createReturnShipment(id: string): Promise<number> {
  const order = await getOrderById(id);
  if (order) {
    if (
      euIso2ForReturn(order.shippingCountry) &&
      process.env.SENDCLOUD_INTL_RETURNS_ENABLED === "true"
    ) {
      return createSendcloudReturn(id);
    }
    if (
      isInternationalOrder(order.shippingCountry) &&
      process.env.AMPHORA_INTL_RETURNS_ENABLED === "true"
    ) {
      return createInternationalReturn(id);
    }
  }
  return createShippingLabel(id);
}

/**
 * Persist the language the customer is using, so the transactional email can be
 * sent in it later — possibly from a context that has no cookies (the Stripe
 * webhook is an inbound request from Stripe, not from the browser).
 *
 * This is the only place `orders.locale` is written. It is safe here and was
 * NOT safe in `setLocale`: by this point the caller has already committed to
 * mutating this very order (`updateFinalOrder(id, ...)` below writes far more
 * consequential state with the same client-supplied id), so writing a
 * whitelisted two-value string adds no new exposure. `setLocale`, by contrast,
 * is reachable from the unauthenticated language switcher on any order id.
 *
 * Must run BEFORE `createStripeUrl`: that call loads the order through the
 * request-scoped `cache()`d `getOrderById`, so a later write would be invisible
 * to the free path's own read of the order.
 *
 * Best-effort — a failure here must not fail the return. Every read site uses
 * `readLocale`, which falls back to "es" for a null column.
 */
async function persistOrderLocale(id: string) {
  try {
    const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
    await db.update(orders).set({ locale }).where(eq(orders.id, id));
  } catch (error) {
    console.error(`Failed to persist locale for order ${id}:`, error);
  }
}

export async function returnFunction(
  id: string,
  isCredit: boolean,
  email: string
) {
  // `id` arrives from the client. Without this the caller only had to know an
  // order id — which is the sequential Shopify order id — to submit somebody
  // else's return, book a carrier against their address and charge their card.
  // Silent: the caller ignores the result, and an unauthorised one should learn
  // nothing.
  if (!(await hasOrderAccess(id))) {
    console.error(`returnFunction: rejected a call without a session for ${id}`);
    return;
  }

  // Before the payment branch, so it covers BOTH outcomes: the free path
  // continues below, and the paid path redirects to Stripe and comes back
  // through the webhook, which reads the column from the database.
  await persistOrderLocale(id);

  // Whether the customer owes anything is decided server-side, inside
  // createStripeUrl. A null URL means nothing to pay.
  const url = (await createStripeUrl(id, email, isCredit)).data;
  if (url) {
    redirect(url);
  }
  try {
    // Caso en el que no tiene que pagar nada
    // First update the database
    await updateFinalOrder(id, false, isCredit);
    // // Then create the return shipment (Correos label or Amphora collection)
    const statusLabel = await createReturnShipment(id);
    if (statusLabel !== 200) {
      // If label creation fails, undo database changes
      await updateFinalOrder(id, true, isCredit); // Assuming we add a revert parameter
      console.error("Failed to create shipping label");
    }
  } catch (error) {
    console.error("Error in order processing:", error);
    // Attempt to undo database changes if there was an error
    try {
      await updateFinalOrder(id, true, isCredit);
    } catch (undoError) {
      console.error("Failed to revert database changes:", undoError);
    }
  }
  redirect(`/success`);
}
