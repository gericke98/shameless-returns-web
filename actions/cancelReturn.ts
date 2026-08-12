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
  const movement = await readCarrierMovement(order?.locator);
  const decision = cancelEligibility(order as any, movement);
  if (!decision.cancellable) return { ok: false, reason: decision.reason };

  // 1. FATAL. Nothing below runs if the warehouse still expects the parcel.
  try {
    await cancelAmphoraReturn(amphoraOrderIdFromShopifyId(orderId));
  } catch (error: any) {
    console.error(
      `Cancel aborted for ${orderId}: Amphora would not cancel the return:`,
      error?.message || error
    );
    return { ok: false, reason: "carrier-cancel-failed" };
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
  const refund = await refundOrderPayment({
    id: orderId,
    email: (order as any).email,
    stripePaymentIntent: (order as any).stripePaymentIntent,
  });
  if (!refund.refunded && refund.reason === "error") {
    await alertOps(
      `Refund FAILED after cancelling ${(order as any).orderNumber}`,
      `Order ${orderId} was cancelled at the customer's request and their return is gone, ` +
        `but the refund did not go through. Refund them by hand in Stripe.`
    );
  }

  // 5. Clean slate — they can start a fresh return immediately.
  await resetOrderReturn(orderId);

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
