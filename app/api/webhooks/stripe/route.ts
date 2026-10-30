import { createShippingLabel } from "@/actions/shipping";
import { createInternationalReturn } from "@/actions/amphoraReturn";
import { createSelfBookedReturn } from "@/actions/selfBookedReturn";
import { alertOps } from "@/actions/opsAlert";
import { confirmSubmission, revertFinalOrder } from "@/lib/submissionConfirmation";
import { enqueueOpsAlert } from "@/actions/opsAlertOutbox";
import { acceptPaidSubmission, getSubmission, type PaidOutcome } from "@/db/submissions";
import { acceptLegacySession } from "@/lib/submissionProposal";
import db from "@/db/drizzle";
import { getOrderById, getOrderByIdFresh } from "@/db/queries";
import { orders } from "@/db/schema";
import { parseCheckoutMetadata } from "@/lib/checkoutMetadata";
import { defaultMethodFor, type ReturnMethod } from "@/lib/returnMethods";
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
      // Fresh, not the request-scoped cached copy: this runs AFTER the revert,
      // and the whole point is to report what the revert actually left behind.
      order = await getOrderByIdFresh(id);
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
        ...survivingReturn(order),
      ].join("\n")
    );
  } catch (alertError) {
    console.error("Could not raise the paid-but-no-return alert:", alertError);
  }
}

/**
 * What the revert actually left behind, in the alert's own words.
 *
 * `revertFinalOrder` REFUSES to revert any line already carrying a Shopify
 * return (the #310957 lesson), so "the database has been reverted" is false
 * whenever the return was created before the booking failed — which is the
 * normal ordering. Order #311329 (2026-08-21) was alerted with that text while
 * its return, its Amphora collection, its DHL tracking and its confirmation
 * email were all alive and correct, and the alert told the responder to refund
 * the customer or re-run the return. Both would have been wrong.
 *
 * An alert that misdescribes the damage is worse than a quiet failure: it sends
 * a human to break something that works.
 */
function survivingReturn(
  order:
    | { products?: Array<{ confirmed?: boolean | null; return_id?: string | null }> }
    | null
    | undefined
): string[] {
  const live = (order?.products ?? []).filter(
    (line) => line?.confirmed === true && line?.return_id
  );

  if (live.length === 0) {
    return [
      `The database has been reverted, so this order looks unsubmitted in the`,
      `dashboard and the portal will ask the customer to pay a second time.`,
      `Either re-run the return for the existing payment or refund it —`,
      `do not leave it, and do not let them pay twice.`,
    ];
  }

  return [
    `The revert was REFUSED: this order still carries a live Shopify return.`,
    ...live.map((line) => `  ${line.return_id}`),
    ``,
    `So the customer is NOT back at square one, and the portal will not ask`,
    `them to pay again. Do not refund and do not re-run blindly — check what`,
    `actually exists first: the Shopify return above, whether the carrier was`,
    `booked (orders.locator / orders.carrier), and whether the customer was`,
    `emailed. The 15-minute Amphora sync may have reconciled it already.`,
    ``,
    `Whatever you find, confirm the exchange stock hold is still in place`,
    `(orders.exchange_reservation_id) — a refused revert used to release it.`,
  ];
}

/**
 * The customer paid, and we deliberately confirmed nothing: the payment is not
 * the one the submission asked for. Either it paid an OLD checkout the
 * customer had already replaced (another tab), or its amount, currency,
 * status or session do not match what was agreed. Confirming it would create
 * a return for terms nobody paid for, so a human decides: refund it in
 * Stripe, or honour it. Nothing here moves money.
 *
 * Through the outbox, keyed on the session: a redelivered webhook is one alert.
 */
async function alertPaymentNotConfirmed(
  orderId: string,
  session: Stripe.Checkout.Session,
  paymentIntentId: string | null,
  outcome: Exclude<PaidOutcome, { kind: "accepted" } | { kind: "duplicate" }>
) {
  const why =
    outcome.kind === "superseded"
      ? `it pays a checkout the customer had already replaced (submission ${outcome.state})`
      : outcome.kind === "mismatch"
        ? `it does not match the agreed terms: ${outcome.detail}`
        : `its submission does not exist`;
  await enqueueOpsAlert({
    dedupeKey: `paid-unconfirmed:${session.id}`,
    subject: `[returns] PAID, NOT CONFIRMED — order ${orderId}`,
    body: [
      `Stripe took a payment for order ${orderId} and NO return was created, because ${why}.`,
      ``,
      `Session:        ${session.id}`,
      `Payment intent: ${paymentIntentId ?? "(none)"}`,
      `Amount:         ${((session.amount_total ?? 0) / 100).toFixed(2)} ${String(session.currency ?? "").toUpperCase()}`,
      ``,
      `Nothing was refunded automatically. Check the order's current submission`,
      `(return_submissions), then either refund this payment in Stripe or`,
      `honour it by hand — do not do both.`,
    ].join("\n"),
  });
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
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null;
      // Una vez se ha procesado el pago vamos con los siguientes pasos
      try {
        let submissionId = metadata.submissionId;
        let outcome: PaidOutcome;
        if (submissionId) {
          // Accept only the payment this submission asked for: this session,
          // this amount, EUR, paid.
          outcome = await acceptPaidSubmission(submissionId, {
            sessionId: session.id,
            amountTotal: session.amount_total ?? null,
            currency: session.currency ?? null,
            paymentStatus: session.payment_status ?? null,
            paymentIntent: paymentIntentId,
          });
        } else {
          // A session created before submissions existed carries none. It is
          // confirmed as it always was — the rows as they stand now — but
          // recorded first, bound to this session, so a redelivery is a
          // duplicate like any other.
          const order = await getOrderById(id);
          const legacyMethod: ReturnMethod =
            ((order as any)?.returnMethod as ReturnMethod) ??
            defaultMethodFor(
              order?.shippingCountry,
              process.env.AMPHORA_INTL_RETURNS_ENABLED === "true"
            );
          const legacy = await acceptLegacySession(id, isCredit, legacyMethod, {
            sessionId: session.id,
            paymentIntent: paymentIntentId,
          });
          if (!legacy) throw new Error(`nothing selected on order ${id} to confirm`);
          submissionId = legacy.kind === "accepted" ? legacy.id : null;
          outcome = legacy.kind === "accepted" ? { kind: "accepted" } : { kind: "duplicate" };
        }

        // A redelivery of a payment already accepted: the first delivery owns
        // the confirmation and the booking. Running them again could race it
        // into a second carrier booking.
        if (outcome.kind === "duplicate") {
          return NextResponse.json({ received: true });
        }
        if (outcome.kind !== "accepted") {
          await alertPaymentNotConfirmed(id, session, paymentIntentId, outcome);
          return NextResponse.json({ received: true });
        }
        if (!submissionId) throw new Error(`order ${id}: accepted without a submission id`);

        // The order's payment is the ACCEPTED one — stored only now, so paying
        // an old checkout cannot overwrite it. A cancellation refunds this
        // intent without a human searching Stripe by hand.
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

        // The lane is the one agreed and paid for, not whatever the order row
        // says by now: another tab can have changed it since checkout.
        const agreed = await getSubmission(submissionId);
        if (!agreed) throw new Error(`order ${id}: submission ${submissionId} vanished after acceptance`);
        const method = agreed.submission.returnMethod as ReturnMethod;

        // // First update the database
        await confirmSubmission(submissionId);
        // // // Then create the return shipment (Correos label or Amphora collection)
        const statusLabel =
          method === "SELF"
            ? await createSelfBookedReturn(id)
            : method === "AMPHORA"
              ? await createInternationalReturn(id)
              : await createShippingLabel(id);
        if (statusLabel !== 200) {
          // If label creation fails, undo database changes
          await revertFinalOrder(id);
          console.error("Failed to create shipping label");
          await alertPaidButNoReturn(
            id,
            session,
            paymentIntentId,
            `carrier booking returned ${statusLabel} (${method})`
          );
        }
      } catch (error) {
        console.error("Error in order processing:", error);
        // Attempt to undo database changes if there was an error
        try {
          await revertFinalOrder(id);
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
