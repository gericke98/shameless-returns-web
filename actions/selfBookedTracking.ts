"use server";

import { and, eq, isNull } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getOrderByIdFresh } from "@/db/queries";
import { hasOrderAccess } from "@/lib/orderAccess";
import { carrierByCode, checkTrackingNumber } from "@/lib/carriers";
import { checkTrackingUrl } from "@/lib/trackingUrl";
import { alertOps } from "@/lib/server/opsAlert";
import { verifyWithCarrier } from "@/lib/carrierLookup";
import { pinSelfTracking } from "@/lib/pinSelfTracking";

export type TrackingSubmission = {
  ok: boolean;
  reason?: string;
  /** Saved, but not yet sent to the warehouse: ops confirms the number first. */
  pending?: boolean;
};

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
  trackingNumber: string,
  /**
   * The customer's tracking link. Required for a carrier whose link we cannot
   * build ("Other"); ignored otherwise, so a client cannot replace a link we
   * build ourselves.
   */
  trackingUrl?: unknown
): Promise<TrackingSubmission> {
  if (!(await hasOrderAccess(id))) {
    console.error(`submitReturnTracking: rejected a call without a session for ${id}`);
    return { ok: false, reason: "no-session" };
  }

  const carrier = carrierByCode(carrierCode);
  if (!carrier) return { ok: false, reason: "unknown-carrier" };

  const order = await getOrderByIdFresh(id);
  if (!order) return { ok: false, reason: "no-order" };
  if ((order as any).returnMethod !== "SELF") {
    return { ok: false, reason: "not-self-booked" };
  }

  // The same check the portal runs as the customer types (lib/carriers):
  // never a coerced non-string, bounded, not the customer's own order number
  // (#311595, #313127 sent theirs and Amphora pinned it), and one this
  // carrier's link can be built from. Before the write-once claim below, so a
  // refusal writes nothing anywhere and the customer can correct it.
  const checkedNumber = checkTrackingNumber(carrier, trackingNumber, order);
  if (!checkedNumber.ok) return { ok: false, reason: checkedNumber.reason };
  const number = checkedNumber.number;

  // `carrier_url` is required by Amphora's approve and pinned with the
  // number, write-once. Built by us where we can, so a client cannot replace
  // it; given by the customer, and validated, where we cannot.
  let carrierUrl: string;
  if (checkedNumber.link !== null) {
    carrierUrl = checkedNumber.link;
  } else {
    const checked = checkTrackingUrl(trackingUrl);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    carrierUrl = checked.url;
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

  // A number reaches Amphora (write-once) only once it is verified
  // (docs/superpowers/plans/2026-11-24-verify-tracking-before-pin.md).
  // Asked BEFORE the claim, so a number the carrier says it does not know
  // writes nothing and the customer can correct it (#311595 and #313127 sent
  // their order number; Correos even returns a parcel for "313127" by
  // reference, which the verdict refuses). "unreadable" (timeout, a page we do
  // not recognise) proves nothing either way: it neither refuses the customer
  // nor approves, it goes to ops like a carrier we cannot ask.
  const verdict = carrier.verify ? await verifyWithCarrier(carrier.verify, number) : null;
  if (verdict === "unknown") return { ok: false, reason: "not-at-carrier" };
  const verified = verdict === "verified";

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
      trackingVerifiedAt: verified ? new Date() : null,
      trackingVerifiedBy: verified ? carrier.verify! : null,
      trackingSubmissionId: crypto.randomUUID(),
    })
    .where(and(eq(orders.id, id), isNull(orders.locator)))
    .returning({ id: orders.id });

  if (writtenRows.length === 0) {
    console.warn(
      `Order ${id}: lost the write-once race — another submit already claimed the tracking slot.`
    );
    return { ok: false, reason: "already-submitted" };
  }

  if (!verified) {
    // Saved, NOT sent to Amphora: ops opens the link and confirms or rejects
    // it in the dashboard (actions/selfTrackingReview.ts). Pinning an
    // unchecked number is what this whole path exists to stop.
    await alertOps(
      `[returns] SELF TRACKING TO CONFIRM — ${order.orderNumber}`,
      [
        `A customer submitted tracking we could not check with the carrier.`,
        `It is saved but NOT sent to the warehouse until someone confirms it.`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        `Carrier:   ${carrier.code}`,
        `Tracking:  ${number}`,
        `Link:      ${carrierUrl}`,
        `Why:       ${verdict === "unreadable" ? `${carrier.code} did not answer our check` : `${carrier.code} cannot be checked automatically`}`,
        ``,
        `Open the link. If the parcel is real, Confirm it in the dashboard;`,
        `otherwise Reject it and the customer is asked for the right number:`,
        `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard`,
      ].join("\n")
    );
    return { ok: true, pending: true };
  }

  await pinSelfTracking({
    id,
    orderNumber: order.orderNumber,
    email: order.email,
    carrier: carrier.code,
    number,
    carrierUrl,
  });

  return { ok: true };
}
