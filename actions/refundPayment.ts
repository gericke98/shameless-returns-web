// DELIBERATELY NOT a server action, and it must never be imported by a client
// component — importing it from one is what would force `"use server"` back on.
//
// The directive published `refundOrderPayment` in Next's server-action
// manifest, which makes it an addressable POST endpoint. It has no session
// check (its only caller, `cancelReturn`, is gated by `hasOrderAccess` before
// it gets here) and it takes `stripePaymentIntent` straight from its argument,
// so anyone who could reach that endpoint could issue a full refund against
// ANY PaymentIntent in our Stripe account. It is a server-side helper called
// from server modules only.
//
// Verified before removing: the only importers are `actions/cancelReturn.ts`
// (a server module) and `tests/refundPayment.test.ts`.

import { stripe } from "@/lib/stripe";

export type RefundOutcome = {
  refunded: boolean;
  reason?: "not-found" | "error";
};

export type RefundableOrder = {
  id: string;
  email: string;
  stripePaymentIntent?: string | null;
};

/** How far back to look for a session when no intent was stored. `orders` has
 *  no timestamp column, so there is nothing to bound this by per-order. */
const LOOKUP_WINDOW_SECONDS = 90 * 24 * 60 * 60;

/** A customer with more paid checkouts than this in 90 days is not a real
 *  case; an unbounded scan on a cancel click is. */
const MAX_SESSIONS_SCANNED = 300;

/**
 * Find the PaymentIntent behind this order's portal charge.
 *
 * `createStripeUrl` sets `customer_email` and puts the order id in the session
 * metadata, which is what makes this recoverable at all. Stripe's Search API
 * does not cover Checkout Sessions, and the metadata is never copied onto the
 * PaymentIntent, so listing is the only route — which is why new charges store
 * the intent directly.
 */
async function resolvePaymentIntentId(order: RefundableOrder): Promise<string | null> {
  if (order.stripePaymentIntent) return order.stripePaymentIntent;

  const nowSeconds = Math.floor(Date.now() / 1000);
  let found: string | null = null;
  let scanned = 0;

  await stripe.checkout.sessions
    .list({
      customer_details: { email: order.email },
      status: "complete",
      created: { gte: nowSeconds - LOOKUP_WINDOW_SECONDS },
      limit: 100,
    })
    .autoPagingEach((session: any) => {
      scanned += 1;
      if (session?.metadata?.id === order.id && session.payment_intent) {
        found =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent.id;
        return false;
      }
      if (scanned >= MAX_SESSIONS_SCANNED) return false;
      return undefined;
    });

  return found;
}

/**
 * Refund everything the customer paid in the portal: the return fee, any
 * exchange price difference, and both shipping legs.
 *
 * Never throws. By the time this runs the Amphora return is already cancelled
 * and — for Spain — the label is dead, so the caller must be able to finish the
 * cancellation and raise an alert rather than die here.
 *
 * The idempotency key is the order id AND the payment intent, so a double
 * click, a retry or a resubmitted action all collapse onto one refund — but a
 * genuinely different payment on the same order (a customer who cancels, then
 * starts and pays for a fresh return, then cancels that too) still gets its
 * own key. Keying on the order id alone made the second cancellation reuse
 * the first one's key against a different `payment_intent`, which Stripe
 * rejects outright and turns into a false `reason: "error"`.
 */
export async function refundOrderPayment(order: RefundableOrder): Promise<RefundOutcome> {
  try {
    const paymentIntent = await resolvePaymentIntentId(order);
    if (!paymentIntent) return { refunded: false, reason: "not-found" };

    await stripe.refunds.create(
      { payment_intent: paymentIntent },
      { idempotencyKey: `cancel:${order.id}:${paymentIntent}` }
    );
    return { refunded: true };
  } catch (error) {
    console.error(`Refund failed for order ${order.id}:`, error);
    return { refunded: false, reason: "error" };
  }
}
