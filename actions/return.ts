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
import { defaultMethodFor, resolveReturnMethod, type ReturnMethod } from "@/lib/returnMethods";
import { getFeeTable } from "@/db/fees";
import { loadBasket } from "@/lib/loadBasket";
import { resolveFee } from "@/lib/fees";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { hasOrderAccess } from "@/lib/orderAccess";
import { alertOps } from "./opsAlert";
import { createInternationalReturn } from "./amphoraReturn";
import { createSelfBookedReturn } from "./selfBookedReturn";

/**
 * Route the physical return. Three lanes now:
 *  1. SELF     → the customer ships it; we book nothing.
 *  2. AMPHORA  → international collection (gated by
 *     AMPHORA_INTL_RETURNS_ENABLED).
 *  3. CORREOS  → Spain, or the flag off.
 *
 * Returns an HTTP-style status (200 = success) in every case, so all three are
 * interchangeable to the caller.
 *
 * There was a fourth lane here once: Sendcloud pre-paid drop-off labels for
 * the EU, taking priority over Amphora. It is gone, along with its module.
 * Amphora already covers every international destination, and the
 * return-method screen tells international customers their parcel will be
 * collected — which a drop-off label would have contradicted for EU orders.
 */
async function createReturnShipment(id: string, method: ReturnMethod): Promise<number> {
  if (method === "SELF") return createSelfBookedReturn(id);
  if (method === "AMPHORA") return createInternationalReturn(id);
  return createShippingLabel(id);
}

/**
 * What the customer's claimed method actually resolves to, and the return-leg
 * price that decides whether SELF was even on offer.
 *
 * Derived server-side from the order and the fee table, never from the claim —
 * the same rule `createStripeUrl` applies to the amount.
 *
 * `resolveReturnMethod` only needs the fee table to arbitrate a SELF claim —
 * every other case, including no claim at all, resolves from the address
 * alone via `defaultMethodFor`. Short-circuiting there keeps every non-SELF
 * submit exactly as cheap (one `getOrderById`, no basket, no fee lookup) as it
 * was before self-booking existed, instead of paying for a fee-table lookup
 * whose result is never even asked for.
 */
async function decideMethod(id: string, claimed: unknown): Promise<ReturnMethod> {
  const amphoraEnabled = process.env.AMPHORA_INTL_RETURNS_ENABLED === "true";

  if (claimed !== "SELF") {
    const order = await getOrderById(id);
    return defaultMethodFor(order?.shippingCountry, amphoraEnabled);
  }

  const loaded = await loadBasket(id);
  if (!loaded) return "CORREOS";

  const { order, basket } = loaded;
  const feeTable = await getFeeTable();
  // Only `returnLegCents` is read here — the return method is a decision about
  // the parcel coming back, not about where the replacement goes — but the real
  // legs are passed rather than sameZone so that a later reader of
  // `outboundLegCents` on this path gets the truth rather than a plausible
  // wrong number.
  const legs = feeLegsForOrder(feeTable, order);
  const { returnLegCents } = resolveFee(legs, basket);

  return resolveReturnMethod(claimed, order.shippingCountry, amphoraEnabled, returnLegCents);
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
 * Persist the lane the customer chose, for the same reason `persistOrderLocale`
 * persists the language: the Stripe webhook is an inbound request from Stripe
 * with no cookies and no client state, so the row is the only channel that
 * survives the redirect.
 *
 * Must run BEFORE `createStripeUrl` — that call reads the order through the
 * request-scoped `cache()`d `getOrderById`, so a later write would be invisible
 * to the free path's own read.
 *
 * Unlike `persistOrderLocale`, a failure here is NOT best-effort. The locale
 * has a sane fallback; this column decides which lane the webhook books, so a
 * swallowed failure prices the checkout at the SELF rate (outbound leg only)
 * and then books a full Correos/Amphora lane. Reports whether the write landed
 * so the caller can price what it will actually book.
 *
 * It becomes deterministically reachable once the deferred DDL lands: the
 * `orders_self_return_needs_carrier` CHECK rejects `return_method = 'SELF'` on
 * a row with a locator and no carrier — exactly a live Correos label. A
 * customer with one who starts a second, self-booked return on the remaining
 * items trips it.
 */
async function persistReturnMethod(id: string, method: ReturnMethod): Promise<boolean> {
  try {
    await db.update(orders).set({ returnMethod: method }).where(eq(orders.id, id));
    return true;
  } catch (error) {
    await alertOps(
      `[returns] RETURN METHOD NOT PERSISTED — order ${id}`,
      [
        `The customer's chosen return lane (${method}) could not be written to the order.`,
        ``,
        `Order:   ${id}`,
        `Failure: ${error instanceof Error ? error.message : String(error)}`,
        ``,
        `The row is the only channel that survives the Stripe redirect, so the`,
        `webhook would have booked the wrong lane. The submit has fallen back to`,
        `the address-derived lane and priced the checkout for THAT, so the`,
        `customer is charged correctly — they just did not get the self-booked`,
        `option they asked for. Check the column, and the CHECK constraint.`,
      ].join("\n")
    );
    return false;
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
  email: string,
  claimedMethod?: unknown
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

  // Resolved and persisted before createStripeUrl for the same reason as the
  // locale above: the webhook has no session and no client state, so the row
  // is the only channel that survives the redirect.
  let method = await decideMethod(id, claimedMethod);
  // If the write did not land, the webhook cannot know the customer chose SELF
  // — it will read a null column and book the address-derived lane. Pricing
  // must follow the lane we will actually book, or the customer pays the
  // outbound leg only and then gets a full Correos/Amphora booking on top.
  if (!(await persistReturnMethod(id, method)) && method === "SELF") {
    const order = await getOrderById(id);
    method = defaultMethodFor(
      order?.shippingCountry,
      process.env.AMPHORA_INTL_RETURNS_ENABLED === "true"
    );
  }

  // Whether the customer owes anything is decided server-side, inside
  // createStripeUrl. A null URL means nothing to pay.
  const url = (await createStripeUrl(id, email, isCredit, method)).data;
  if (url) {
    redirect(url);
  }
  try {
    // Caso en el que no tiene que pagar nada
    // First update the database
    await updateFinalOrder(id, false, isCredit);
    // // Then create the return shipment (Correos label, Amphora collection, or self-booked)
    const statusLabel = await createReturnShipment(id, method);
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
