import "server-only";
// Order writes the submit path makes before and after checkout. Each takes a
// `VerifiedOrderId` (F1 spec §1): the customer's submit handler (portal
// session) and the Stripe webhook (signature) are their only callers.
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import db, { writeDb } from "@/db/drizzle";
import { orders } from "@/db/schema";
import { LOCALE_COOKIE, readLocale } from "@/lib/i18n";
import type { ReturnMethod } from "@/lib/returnMethods";
import { alertOps } from "./opsAlert";
import { createShippingLabel } from "./shipping";
import { createInternationalReturn } from "./amphoraReturn";
import { createSelfBookedReturn } from "./selfBookedReturn";
import type { VerifiedOrderId } from "./identity";

/**
 * Route the physical return. Three lanes:
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
export async function createReturnShipment(id: VerifiedOrderId, method: ReturnMethod): Promise<number> {
  if (method === "SELF") return createSelfBookedReturn(id);
  if (method === "AMPHORA") return createInternationalReturn(id);
  return createShippingLabel(id);
}

/**
 * Persist the language the customer is using, so the transactional email can be
 * sent in it later — possibly from a context that has no cookies (the Stripe
 * webhook is an inbound request from Stripe, not from the browser).
 *
 * This is the only place `orders.locale` is written. `setLocale` only sets the
 * cookie: it is public, and has no order to write to.
 *
 * Must run BEFORE `createStripeUrl`: that call loads the order through the
 * request-scoped `cache()`d `getOrderById`, so a later write would be invisible
 * to the free path's own read of the order.
 *
 * Best-effort — a failure here must not fail the return. Every read site uses
 * `readLocale`, which falls back to "es" for a null column.
 */
export async function persistOrderLocale(id: VerifiedOrderId) {
  try {
    const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
    await writeDb(id).update(orders).set({ locale }).where(eq(orders.id, id));
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
export async function persistReturnMethod(id: VerifiedOrderId, method: ReturnMethod): Promise<boolean> {
  try {
    await writeDb(id).update(orders).set({ returnMethod: method }).where(eq(orders.id, id));
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
