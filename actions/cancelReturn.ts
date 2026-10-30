"use server";

import axios from "axios";
import { getOrderByIdFresh } from "@/db/queries";
import {
  cancelShopifyReturn,
  claimOrderForCancellation,
  finishCancellation,
  releaseCancellation,
} from "@/lib/submissionCancellation";
import { hasOrderAccess } from "@/lib/orderAccess";
import { cancelEligibility, type CancelBlockedReason } from "@/lib/cancelEligibility";
import { readCarrierMovement } from "./shipping";
import { amphoraOrderIdFromShopifyId, cancelAmphoraReturn } from "./amphora";
import { releaseHoldForCancellation } from "@/lib/settlement/holdRelease";
import { refundOrderPayment } from "./refundPayment";
import { alertOps } from "./opsAlert";
import { dictionaries, readLocale } from "@/lib/i18n";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

export type CancelResult =
  | { ok: true }
  | { ok: false; reason: CancelBlockedReason | "carrier-cancel-failed" | "forbidden" | "needs-support" };

/**
 * Cancel a customer's return or exchange and give them their money back.
 *
 * The order of reversals is the whole design, and it changes meaning halfway
 * through:
 *
 *   0. Claim        — establish EVERY submission behind the return, each with
 *                      its own Shopify return and payment, and take them all
 *                      from settlement (S2 plan L2). Refused, before anything
 *                      external, when any of that cannot be established.
 *   1. Amphora cancel  — FATAL. The only booking either lane lets us release.
 *   2. Shopify cancel  — each submission's OWN return; continue on failure,
 *                        alert a human.
 *   3. Release hold    — never throws; continue on failure, alert a human.
 *   4. Stripe refund   — each submission's OWN payment, key
 *                        `cancel:<submission id>`; continue on failure, alert.
 *   5. One transaction: submissions `cancelled`, then our rows reset.
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

  // 0. Ownership and membership, BEFORE the first external effect.
  //    Settlement that has admitted anything owns the submission; then this
  //    return is settling. A row or payment nobody can attribute is a human's.
  const claim = await claimOrderForCancellation(((order as any)?.products ?? []) as any[]);
  if (!claim.ok) {
    if (claim.reason === "needs-support") {
      await alertOps(
        `Cancellation REFUSED — cannot attribute the return (${(order as any)?.orderNumber})`,
        `A customer asked to cancel the return on order ${orderId}. Nothing was cancelled or refunded:\n` +
          `${claim.detail}\n\nThe customer was asked to email us. Cancel it by hand.`
      );
    }
    return { ok: false, reason: claim.reason };
  }
  const members = claim.members;
  const submissionIds = members.map((m) => m.submissionId);
  const giveBack = async () => {
    for (const id of submissionIds) await releaseCancellation(id);
  };

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
      // Nothing moved: settlement may have it back.
      await giveBack();
      return { ok: false, reason: "carrier-cancel-failed" };
    }
    console.warn(
      `Order ${orderId}: no Amphora ticket to cancel for a self-booked return — continuing.`
    );
  }

  // 2. Each submission's OWN Shopify return. Continue on failure — an open
  //    Shopify return is an ops problem, and stopping here would leave the
  //    customer with no return and no money.
  for (const member of members) {
    const cancelled = await cancelShopifyReturn(member.returnId);
    if (!cancelled.success) {
      await alertOps(
        `Shopify return ${member.returnId} still open after cancellation (${(order as any).orderNumber})`,
        `Order ${orderId} (submission ${member.submissionId}) was cancelled by the customer and refunded, ` +
          `but returnCancel failed:\n${JSON.stringify(cancelled.errors)}\n\n` +
          `Close it by hand, or an admin validating it later will refund the garment too.`
      );
    }
  }

  // 3. Never throws, but `released: false` means the hold is still live: the
  //    replacement stock stays frozen behind nothing but this alert once
  //    step 5 drops the row from the dashboard.
  const hold = await releaseHoldForCancellation(orderId, submissionIds);
  if (!hold.released) {
    await alertOps(
      `Exchange stock hold not released after cancelling ${(order as any).orderNumber}`,
      `Order ${orderId} was cancelled by the customer, but its stock hold was not released: ${hold.reason}. ` +
        `The replacement garment's stock hold may still be live in Shopify — release it by hand.`
    );
  }

  // 4. Each submission's OWN payment, keyed by its own id: a retry of the same
  //    cancellation reuses each key, and no payment is refunded on another's
  //    behalf. `not-found` is not a failure: a free return had nothing to refund.
  for (const member of members) {
    if (member.payment.kind === "none") continue;
    const paymentIntent =
      member.payment.kind === "intent" ? member.payment.paymentIntent : (order as any).stripePaymentIntent;
    const refund = await refundOrderPayment(
      { id: orderId, email: (order as any).email, stripePaymentIntent: paymentIntent },
      member.submissionId
    );
    if (!refund.refunded && refund.reason === "error") {
      await alertOps(
        `Refund FAILED after cancelling ${(order as any).orderNumber}`,
        `Order ${orderId} (submission ${member.submissionId}) was cancelled at the customer's request and ` +
          `their return is gone, but the refund did not go through. Refund them by hand in Stripe.\n\n` +
          // Step 5 clears `stripe_payment_intent` from the order row; the
          // submission keeps its own.
          `Payment intent: ${paymentIntent || "not stored — find the Checkout Session by " +
            `customer_email ${(order as any).email} and metadata.id ${orderId}`}`
      );
    }
  }

  // 5. Clean slate — they can start a fresh return immediately.
  //
  // Guarded because it is two separate updates and the customer's money has
  // already moved. A throw escaping here would skip step 6 as well: no email,
  // no alert, and a row still `confirmed` with a `return_id` for a Shopify
  // return that no longer exists — a phantom live return on the dashboard that
  // an admin would settle, refunding the garment on top of the fee.
  try {
    await finishCancellation(orderId, submissionIds);
  } catch (error: any) {
    await alertOps(
      `Order rows NOT reset after cancelling ${(order as any).orderNumber}`,
      `Order ${orderId} was cancelled at the customer's request and refunded, but ` +
        `finishCancellation threw:\n${error?.message || error}\n\n` +
        `The order and/or its lines may still carry confirmed = true and a return_id for a ` +
        `Shopify return that is already cancelled, so the dashboard may show a PHANTOM live ` +
        `return. Its submission stays held by cancellation, so settlement will not pay it; ` +
        `the recovery cron alerts on it after an hour. Clear the rows by hand.`
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
