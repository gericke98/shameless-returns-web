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
import { defaultMethodFor } from "@/lib/returnMethods";
import { hasOrderAccess } from "@/lib/orderAccess";
import { alertOps } from "./opsAlert";
import { createInternationalReturn, isInternationalOrder } from "./amphoraReturn";

/**
 * Route the physical return:
 *  1. International → Amphora collection (gated by
 *     AMPHORA_INTL_RETURNS_ENABLED).
 *  2. Spain, or the flag off → Correos label (unchanged).
 * Returns an HTTP-style status (200 = success) in every case. With the flag
 * off this is behaviour-identical to the Correos-only flow.
 *
 * There was a third lane here: Sendcloud pre-paid drop-off labels for the EU,
 * taking priority over Amphora. It is gone, along with its module. Amphora
 * already covers every international destination, and the return-method screen
 * tells international customers their parcel will be collected — which a
 * drop-off label would have contradicted for EU orders.
 */
async function createReturnShipment(id: string): Promise<number> {
  const order = await getOrderById(id);
  if (
    order &&
    isInternationalOrder(order.shippingCountry) &&
    process.env.AMPHORA_INTL_RETURNS_ENABLED === "true"
  ) {
    return createInternationalReturn(id);
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

/**
 * The free lane's equivalent of the webhook's `alertPaidButNoReturn`.
 *
 * Order #311174, 2026-08-12 07:39:36Z: the Shopify return was created, the
 * Correos booking failed, and the customer was sent to /success. The only
 * trace was a `console.error` in logs Vercel keeps for about an hour, so this
 * surfaced eight days later, from the customer, and by then the reason Correos
 * refused was long gone.
 *
 * There is no charge to refund here — that is the whole difference from the
 * paid path — but the customer is in a worse position than an untouched one:
 * they believe the return is booked. So the alert has to say that plainly,
 * because nobody should be waiting for them to complain.
 *
 * Best effort, and never allowed to throw: this is already the failure path,
 * and the redirect to /success must still happen.
 */
async function alertReturnWithoutLabel(id: string, detail: string) {
  try {
    let order: Awaited<ReturnType<typeof getOrderById>> | null = null;
    try {
      order = await getOrderById(id);
    } catch {
      // An alert naming only the raw id beats no alert because the lookup that
      // just failed is still failing.
    }

    await alertOps(
      `[returns] NO LABEL — ${order?.orderNumber ?? `order ${id}`}`,
      [
        `A return was submitted and no carrier booking exists for it.`,
        ``,
        `Order:     ${order?.orderNumber ?? "(unknown)"} (id ${id})`,
        `Customer:  ${order?.email ?? "(unknown)"}`,
        `Country:   ${order?.shippingCountry ?? "(unknown)"}`,
        `Postcode:  ${order?.shippingZip ?? "(unknown)"}`,
        ``,
        `Failure:   ${detail}`,
        ``,
        `Nothing was charged. The customer was still shown /success, so they`,
        `believe the return is booked and will not necessarily write in —`,
        `do not wait for them to.`,
        ``,
        `The revert refuses any row that already carries a Shopify return, so`,
        `the return is probably live with no label against it. Check the order,`,
        `then re-run the booking — a fresh label is a real, uncancellable`,
        `parcel, so book exactly one and email it.`,
      ].join("\n")
    );
  } catch (alertError) {
    console.error("Could not raise the no-label alert:", alertError);
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
  //
  // The method passed here is always the address-derived default — this call
  // site does not yet let the customer choose SELF, so behaviour for every
  // existing customer is unchanged. Task 7 replaces this with their real
  // choice. `getOrderById` is React-`cache()`d, so this extra call is free.
  const order = await getOrderById(id);
  const url = (
    await createStripeUrl(
      id,
      email,
      isCredit,
      defaultMethodFor(order?.shippingCountry, process.env.AMPHORA_INTL_RETURNS_ENABLED === "true")
    )
  ).data;
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
      await alertReturnWithoutLabel(id, `carrier booking returned ${statusLabel}`);
    }
  } catch (error) {
    console.error("Error in order processing:", error);
    const detail = error instanceof Error ? error.message : String(error);
    // Attempt to undo database changes if there was an error
    try {
      await updateFinalOrder(id, true, isCredit);
      await alertReturnWithoutLabel(id, detail);
    } catch (undoError) {
      console.error("Failed to revert database changes:", undoError);
      // Worse than the original failure: our records now disagree with
      // reality as well. Say so, rather than reporting only the first error.
      await alertReturnWithoutLabel(
        id,
        `${detail} — AND the revert then failed (${
          undoError instanceof Error ? undoError.message : String(undoError)
        }), so the database may be inconsistent`
      );
    }
  }
  redirect(`/success`);
}
