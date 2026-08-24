"use server";

import axios from "axios";
import { getOrderByIdFresh, cancelShopifyReturn, resetOrderReturn } from "@/db/queries";
import { hasOrderAccess } from "@/lib/orderAccess";
import { cancelEligibility, type CancelBlockedReason } from "@/lib/cancelEligibility";
import { readCarrierMovement } from "./shipping";
import { amphoraOrderIdFromShopifyId, cancelAmphoraReturn } from "./amphora";
import { releaseExchangeReservation } from "./exchangeReservation";
import { refundOrderPayment } from "./refundPayment";
import { alertOps } from "./opsAlert";
import { dictionaries, readLocale } from "@/lib/i18n";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

export type CancelResult =
  | { ok: true }
  | { ok: false; reason: CancelBlockedReason | "carrier-cancel-failed" | "forbidden" };

/**
 * Cancel a customer's return or exchange and give them their money back.
 *
 * The order of reversals is the whole design, and it changes meaning halfway
 * through:
 *
 *   1. Amphora cancel  — FATAL. The only booking either lane lets us release.
 *   2. Shopify cancel  — continue on failure, alert a human.
 *   3. Release hold    — never throws; continue on failure, alert a human.
 *   4. Stripe refund   — continue on failure, alert a human.
 *   5. Reset our rows.
 *   6. Email the customer.
 *
 * Past step 1 the customer's return no longer exists and, for Spain, their
 * Correos label cannot be voided (probed 2026-08-12: BajaOp rejects our
 * shipments, AnularOp needs Oid/Eid we cannot obtain). So they are owed their
 * refund whatever else breaks, and a partial failure becomes an ops problem
 * rather than a reason to strand them.
 */
export async function cancelReturnFunction(orderId: string): Promise<CancelResult> {
  // `orders.id` is the raw sequential Shopify order id. Without this, knowing a
  // number would let anyone cancel a stranger's return and refund their card.
  if (!(await hasOrderAccess(orderId))) {
    console.error(`cancelReturnFunction: rejected a call without a session for ${orderId}`);
    return { ok: false, reason: "forbidden" };
  }

  // `getOrderById` is memoized by React `cache()` for the lifetime of one
  // render pass — right for a page reading an order from several components,
  // wrong here: this ACTS on what it reads (refund, settle, reset), and a
  // warm serverless instance replaying a stale snapshot is exactly the
  // incident `getOrderByIdFresh` exists to prevent (see db/queries.ts). A
  // stale `refunded: false` would walk through the already-settled gate into
  // a second refund; a stale `returnStatus` would walk through in-transit
  // into refunding a garment already on its way to us.
  const order = await getOrderByIdFresh(orderId);
  // `carrier` decides WHICH carrier may be asked. `locator` holds a Correos
  // CodEnvio for a Spanish return but Amphora's carrier_number for an
  // international one, and asking Correos about a UPS reference reads back as
  // "unreadable" — which used to block every non-Spain cancellation forever.
  const movement = await readCarrierMovement(order?.locator, (order as any)?.carrier);
  const decision = cancelEligibility(order as any, movement);
  if (!decision.cancellable) return { ok: false, reason: decision.reason };

  // 1. FATAL. Nothing below runs if the warehouse still expects the parcel.
  try {
    await cancelAmphoraReturn(amphoraOrderIdFromShopifyId(orderId));
  } catch (error: any) {
    // A self-booked return whose ticket was never opened has nothing for
    // Amphora to cancel — createSelfBookedReturn alerts and continues when the
    // create fails. Treating that 404 as fatal would trap the customer in a
    // return that exists only on our side. Any other failure stays fatal: the
    // warehouse still expecting a parcel is exactly what step 1 guards.
    const missing = error?.response?.status === 404;
    if (!((order as any)?.returnMethod === "SELF" && missing)) {
      console.error(
        `Cancel aborted for ${orderId}: Amphora would not cancel the return:`,
        error?.message || error
      );
      return { ok: false, reason: "carrier-cancel-failed" };
    }
    console.warn(
      `Order ${orderId}: no Amphora ticket to cancel for a self-booked return — continuing.`
    );
  }

  // 2. Continue on failure — an open Shopify return is an ops problem, and
  //    stopping here would leave the customer with no return and no money.
  const returnId = (order as any)?.products?.find((line: any) => line?.return_id)?.return_id;
  if (returnId) {
    const cancelled = await cancelShopifyReturn(returnId);
    if (!cancelled.success) {
      await alertOps(
        `Shopify return ${returnId} still open after cancellation (${(order as any).orderNumber})`,
        `Order ${orderId} was cancelled by the customer and refunded, but returnCancel failed:\n` +
          `${JSON.stringify(cancelled.errors)}\n\n` +
          `Close it by hand, or an admin validating it later will refund the garment too.`
      );
    }
  } else {
    // No id to cancel with, which should be impossible for a confirmed return:
    // `updateFinalOrder` writes `return_id` onto every line at creation. When
    // it happens anyway — a half-created return, a partial revert — the branch
    // above is skipped, and skipping it SILENTLY is the harm: the Shopify
    // return is still open, the customer has been refunded a step later, and
    // an admin validating it refunds the garment on top. Nothing else would
    // ever notice, because step 5 drops the row off the dashboard.
    await alertOps(
      `Cancelled return had no Shopify return id (${(order as any).orderNumber})`,
      `Order ${orderId} was cancelled by the customer and refunded, but none of its lines ` +
        `carried a return_id, so no returnCancel was sent. If a Shopify return exists for ` +
        `this order it is STILL OPEN — find it and close it by hand, or an admin validating ` +
        `it later will refund the garment too.`
    );
  }

  // 3. Never throws, but a `false` means the hold is still live: the
  //    replacement stock stays frozen behind nothing but this alert once
  //    `resetOrderReturn` (step 5) drops the row from the dashboard.
  const released = await releaseExchangeReservation(orderId);
  if (!released) {
    await alertOps(
      `Exchange stock hold not released after cancelling ${(order as any).orderNumber}`,
      `Order ${orderId} was cancelled by the customer, but releaseExchangeReservation failed. ` +
        `The replacement garment's stock hold may still be live in Shopify — release it by hand.`
    );
  }

  // 4. `not-found` is not a failure: a free return had nothing to refund.
  const paymentIntent = (order as any).stripePaymentIntent;
  const refund = await refundOrderPayment({
    id: orderId,
    email: (order as any).email,
    stripePaymentIntent: paymentIntent,
  });
  if (!refund.refunded && refund.reason === "error") {
    await alertOps(
      `Refund FAILED after cancelling ${(order as any).orderNumber}`,
      `Order ${orderId} was cancelled at the customer's request and their return is gone, ` +
        `but the refund did not go through. Refund them by hand in Stripe.\n\n` +
        // Step 5 clears `stripe_payment_intent` from the row, so this line is
        // the only surviving pointer to the charge that needs reversing.
        `Payment intent: ${paymentIntent || "not stored — find the Checkout Session by " +
          `customer_email ${(order as any).email} and metadata.id ${orderId}`}`
    );
  }

  // 5. Clean slate — they can start a fresh return immediately.
  //
  // Guarded because it is two separate updates and the customer's money has
  // already moved. A throw escaping here would skip step 6 as well: no email,
  // no alert, and a row still `confirmed` with a `return_id` for a Shopify
  // return that no longer exists — a phantom live return on the dashboard that
  // an admin would settle, refunding the garment on top of the fee.
  try {
    await resetOrderReturn(orderId);
  } catch (error: any) {
    await alertOps(
      `Order rows only half-reset after cancelling ${(order as any).orderNumber}`,
      `Order ${orderId} was cancelled at the customer's request and refunded, but ` +
        `resetOrderReturn threw:\n${error?.message || error}\n\n` +
        `The order and/or its lines may still carry confirmed = true and a return_id for a ` +
        `Shopify return that is already cancelled, so the dashboard may show a PHANTOM live ` +
        `return. Do not validate it — clear the rows by hand.`
    );
  }

  // 6. Tell them, in the language they used.
  await sendCancellationEmail(order as any);

  return { ok: true };
}

/**
 * Best effort. The cancellation is already done and correct; failing to
 * announce it must not report failure to a customer whose return is gone.
 */
async function sendCancellationEmail(order: {
  email: string;
  locale?: string | null;
  orderNumber: string;
}): Promise<void> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return;

  const t = dictionaries[readLocale(order.locale)];
  try {
    await axios.post(
      POSTMARK_API_URL,
      {
        From: "hello@shamelesscollective.com",
        To: order.email,
        Subject: `${t.cancel.emailSubject} ${order.orderNumber}`,
        TextBody: `${t.cancel.emailBody}\n\n${t.cancel.emailLabelWarning}`,
        MessageStream: "outbound",
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
      }
    );
  } catch (error: any) {
    console.error(`Cancellation email failed for ${order.orderNumber}:`, error?.message);
  }
}
