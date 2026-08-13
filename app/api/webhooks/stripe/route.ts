import { createShippingLabel } from "@/actions/shipping";
import { createInternationalReturn, isInternationalOrder } from "@/actions/amphoraReturn";
import { alertOps } from "@/actions/opsAlert";
import { updateFinalOrder } from "@/actions/updateOrder";
import db from "@/db/drizzle";
import { getOrderById } from "@/db/queries";
import { orders } from "@/db/schema";
import { parseCheckoutMetadata } from "@/lib/checkoutMetadata";
import { stripe } from "@/lib/stripe";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

/** Same third-party chain as the free path (Shopify -> carrier -> Postmark),
 *  so it needs the same headroom as `app/[id]/page.tsx`. A timeout here is
 *  worse: Stripe has already taken the money. */
export const maxDuration = 60;

/**
 * Tell a human that we took the money and produced no return.
 *
 * This handler catches every downstream failure, reverts, and answers 200. That
 * combination is silent by construction: Stripe sees a healthy endpoint so it
 * schedules no retry, and the revert puts the row back to "nothing submitted"
 * so the order also drops out of the dashboard. The only trace was a
 * `console.error` in logs Vercel keeps for about an hour.
 *
 * Order #310741 lived in that state for ten days — paid, no Shopify return, no
 * collection, no email — and surfaced only because the customer wrote in twice.
 * After the revert, Stripe was the single place the payment still existed.
 *
 * So the alert carries what a human needs to act without reconstructing any of
 * it: which order, which customer, how much, and the PaymentIntent to refund.
 * Best-effort throughout — this is the fallback path, and it must never be able
 * to throw over the failure it is reporting.
 */
async function alertPaidButNoReturn(
  id: string,
  session: Stripe.Checkout.Session,
  paymentIntentId: string | null,
  reason: unknown
): Promise<void> {
  try {
    let order: Awaited<ReturnType<typeof getOrderById>> | null = null;
    try {
      order = await getOrderById(id);
    } catch {
      // Reporting beats accuracy here: an alert naming only the raw id is far
      // better than no alert because the lookup that failed a moment ago is
      // still failing.
    }

    const amount =
      typeof session.amount_total === "number"
        ? (session.amount_total / 100).toFixed(2)
        : "unknown";
    const currency = (session.currency ?? "eur").toUpperCase();
    const detail =
      reason instanceof Error ? reason.message : String(reason ?? "unknown");

    await alertOps(
      `[returns] PAID BUT NO RETURN — ${order?.orderNumber ?? `order ${id}`}`,
      [
        `The customer's card was charged and no return exists for it.`,
        ``,
        `Order:     ${order?.orderNumber ?? "(unknown)"} (id ${id})`,
        `Customer:  ${order?.email ?? "(unknown)"}`,
        `Country:   ${order?.shippingCountry ?? "(unknown)"}`,
        `Charged:   ${amount} ${currency}`,
        `Refund:    ${paymentIntentId ?? "(no PaymentIntent on the session)"}`,
        ``,
        `Failure:   ${detail}`,
        ``,
        `The database has been reverted, so this order looks unsubmitted in the`,
        `dashboard and the portal will ask the customer to pay a second time.`,
        `Either re-run the return for the existing payment or refund it —`,
        `do not leave it, and do not let them pay twice.`,
      ].join("\n")
    );
  } catch (alertError) {
    console.error("Could not raise the paid-but-no-return alert:", alertError);
  }
}

export async function POST(req: Request) {
  const body = await req.text();
  const signature = headers().get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "No signature found in request" },
      { status: 400 }
    );
  }

  try {
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
    const session = event.data.object as Stripe.Checkout.Session;

    if (event.type === "checkout.session.completed") {
      const metadata = parseCheckoutMetadata(session.metadata);
      if (!metadata) {
        return new NextResponse("Metadata is required", { status: 400 });
      }
      const { id, isCredit } = metadata;
      // Store the payment before anything else can fail. A cancellation later
      // needs it to refund without a human searching Stripe by hand.
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null;
      if (paymentIntentId) {
        try {
          await db
            .update(orders)
            .set({ stripePaymentIntent: paymentIntentId })
            .where(eq(orders.id, id));
        } catch (error) {
          console.error(`Could not store payment intent for order ${id}:`, error);
        }
      }
      // Una vez se ha procesado el pago vamos con los siguientes pasos
      try {
        // // First update the database
        await updateFinalOrder(id, false, isCredit);
        // // // Then create the return shipment (Correos label or Amphora collection)
        const order = await getOrderById(id);
        const useAmphora =
          !!order &&
          isInternationalOrder(order.shippingCountry) &&
          process.env.AMPHORA_INTL_RETURNS_ENABLED === "true";
        const statusLabel = useAmphora
          ? await createInternationalReturn(id)
          : await createShippingLabel(id);
        if (statusLabel !== 200) {
          // If label creation fails, undo database changes
          await updateFinalOrder(id, true, isCredit); // Assuming we add a revert parameter
          console.error("Failed to create shipping label");
          await alertPaidButNoReturn(
            id,
            session,
            paymentIntentId,
            `carrier booking returned ${statusLabel} (${
              useAmphora ? "Amphora collection" : "Correos label"
            })`
          );
        }
      } catch (error) {
        console.error("Error in order processing:", error);
        // Attempt to undo database changes if there was an error
        try {
          await updateFinalOrder(id, true, isCredit);
        } catch (undoError) {
          console.error("Failed to revert database changes:", undoError);
          // Worse than the failure being reported: the money is taken, the
          // return may be half-created, and our records now disagree with
          // reality. Say so in the alert rather than reporting only the
          // original error.
          await alertPaidButNoReturn(
            id,
            session,
            paymentIntentId,
            `${error instanceof Error ? error.message : String(error)} — AND the revert then failed (${
              undoError instanceof Error ? undoError.message : String(undoError)
            }), so the database may be inconsistent`
          );
          return NextResponse.json({ received: true });
        }
        await alertPaidButNoReturn(id, session, paymentIntentId, error);
      }

      return NextResponse.json({ received: true });
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return NextResponse.json(
      {
        error: `Webhook error: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      },
      { status: 400 }
    );
  }
}
