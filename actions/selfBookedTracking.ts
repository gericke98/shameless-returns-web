"use server";

import { and, eq, isNull } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getOrderByIdFresh } from "@/db/queries";
import { hasOrderAccess } from "@/lib/orderAccess";
import { carrierByCode } from "@/lib/carriers";
import { amphoraOrderIdFromShopifyId, approveAmphoraReturn } from "./amphora";
import { alertOps } from "./opsAlert";

export type TrackingSubmission = { ok: boolean; reason?: string };

/**
 * The capture half of a self-booked return: the customer tells us who they
 * shipped with and the tracking number, and we tell the warehouse.
 *
 * Session-gated, unlike `createShippingLabel`: this one is only ever reached
 * from the portal by the customer, never from a webhook, so there is no paid
 * flow to break by requiring a session.
 *
 * ⚠️ Deliberately NOT `getOrderById` — that is wrapped in React `cache()` and
 * would serve a stale row to a second submit arriving in the same request,
 * defeating the idempotency guard below.
 */
export async function submitReturnTracking(
  id: string,
  carrierCode: string,
  trackingNumber: string
): Promise<TrackingSubmission> {
  if (!(await hasOrderAccess(id))) {
    console.error(`submitReturnTracking: rejected a call without a session for ${id}`);
    return { ok: false, reason: "no-session" };
  }

  const carrier = carrierByCode(carrierCode);
  if (!carrier) return { ok: false, reason: "unknown-carrier" };

  const number = String(trackingNumber ?? "").trim();
  if (!number) return { ok: false, reason: "empty-tracking" };

  const order = await getOrderByIdFresh(id);
  if (!order) return { ok: false, reason: "no-order" };
  if ((order as any).returnMethod !== "SELF") {
    return { ok: false, reason: "not-self-booked" };
  }

  // Idempotency, and the reason it matters more here than anywhere else:
  // Amphora pins `carrier_number` at approve. Re-approving 422s, and
  // cancel-and-recreate hands back the OLD number — so a second submit would
  // desync the warehouse permanently. Stop before Amphora, not after.
  if (order.locator) {
    console.warn(
      `Order ${id}: tracking ${order.locator} already submitted — refusing to replace it.`
    );
    return { ok: false, reason: "already-submitted" };
  }

  const carrierUrl = carrier.trackingUrl(number);

  // Written together, and BEFORE Amphora: `carrier` must never be null on a row
  // that has a locator, or `tracksWithCorreos` reads the null as "our own
  // Correos label" and sends a foreign tracking number to localizador.correos.es.
  // The check constraint enforces the same thing at the database.
  //
  // The `if (order.locator)` check above is only a fast-path rejection — it is
  // check-then-act, and two near-simultaneous submits (a double-click that
  // beats the disabled state, a retried POST, two open tabs) can both read
  // `locator` as null before either write lands. If both then reached
  // Amphora, the second call's carrier_number would be rejected as write-once
  // — but if both reached this UPDATE unconditionally, the second write would
  // still overwrite the row, leaving our DB and the dashboard pointing at a
  // carrier Amphora never pinned. That is the exact desync this task exists
  // to prevent, so the database, not this function, must decide who wins:
  // `isNull(orders.locator)` in the WHERE clause means only a row that STILL
  // has no locator gets written, and `.returning()` tells us whether ours was
  // the write that landed. Only the winner may go on to call Amphora, because
  // Amphora's pin cannot be undone.
  const writtenRows = await db
    .update(orders)
    .set({
      locator: number,
      carrier: carrier.code,
      carrierUrl,
      trackingSubmittedAt: new Date(),
    })
    .where(and(eq(orders.id, id), isNull(orders.locator)))
    .returning({ id: orders.id });

  if (writtenRows.length === 0) {
    console.warn(
      `Order ${id}: lost the write-once race — another submit already claimed the tracking slot.`
    );
    return { ok: false, reason: "already-submitted" };
  }

  // Best-effort, and swallowed: the customer has done everything asked of them
  // and the parcel is already moving. Never silent, though.
  try {
    await approveAmphoraReturn(amphoraOrderIdFromShopifyId(id), {
      carrier: carrier.code,
      carrier_number: number,
      carrier_url: carrierUrl,
    });
  } catch (error: any) {
    await alertOps(
      `[returns] SELF RETURN NOT APPROVED — ${order.orderNumber}`,
      [
        `A customer submitted tracking and the warehouse was not told.`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        `Carrier:   ${carrier.code}`,
        `Tracking:  ${number}`,
        ``,
        `Failure:   ${error?.response?.data || error?.message || error}`,
        ``,
        `We hold the tracking; Amphora does not. Approve the ticket by hand`,
        `with this carrier data. Note carrier_number is write-once, so get it`,
        `right the first time.`,
      ].join("\n")
    );
  }

  return { ok: true };
}
