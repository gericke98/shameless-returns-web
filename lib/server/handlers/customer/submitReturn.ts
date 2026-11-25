import "server-only";
// The portal's submit (F1 spec §4 `submitReturn`). Wrapped by `customerAction`
// in actions/return.ts, so `ctx.orderId` is the session's order and the client
// sends only its choices: the payout, and the lane it claims. Never the email,
// never an amount, never the order's own data.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrderById } from "@/db/queries";
import { getFeeTable } from "@/db/fees";
import { defaultMethodFor, resolveReturnMethod, type ReturnMethod } from "@/lib/returnMethods";
import { loadBasket } from "@/lib/loadBasket";
import { resolveFee } from "@/lib/fees";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { confirmSubmission, revertFinalOrder } from "@/lib/submissionConfirmation";
import type { ProposalRefusal } from "@/lib/submissionProposal";
import { ok, refuse, type HandlerResult } from "@/lib/actionResult";
import type { CustomerContext } from "@/lib/server/actions";
import type { VerifiedOrderId } from "@/lib/server/identity";
import { alertOps } from "@/lib/server/opsAlert";
import { enqueueOpsAlert } from "@/lib/server/opsAlertOutbox";
import { createStripeUrl } from "@/lib/server/payments";
import { acceptFreeSubmission } from "@/lib/server/submissionScope";
import {
  createReturnShipment,
  persistOrderLocale,
  persistReturnMethod,
} from "@/lib/server/returnSubmission";

export const submitReturnInput = z
  .object({
    expectedOrderId: z.string(),
    /** Null when no payout step was shown (nothing comes back to the customer). */
    payout: z.enum(["refund", "credit"]).nullable(),
    /** A claim: the server resolves the real lane (`decideMethod`). */
    method: z.enum(["CORREOS", "AMPHORA", "SELF"]),
  })
  .strict();

export type SubmitReturnRefusal = ProposalRefusal;

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
 * was before self-booking existed.
 */
async function decideMethod(id: VerifiedOrderId, claimed: ReturnMethod): Promise<ReturnMethod> {
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
 * and the customer must still be sent to /success.
 */
async function alertReturnWithoutLabel(id: VerifiedOrderId, detail: string) {
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

/**
 * The submit was refused before anything was booked or charged. The portal's
 * own gate (lib/portalWizard) should make that unreachable, so reaching it
 * means the client and server drifted: ops hears about it durably, since
 * Vercel keeps the server log about a day.
 */
async function alertSubmitRefused(id: VerifiedOrderId, isCredit: boolean | null, reason: SubmitReturnRefusal) {
  console.error(`submitReturn: submit refused for order ${id}: ${reason}`);
  try {
    await enqueueOpsAlert({
      dedupeKey: `submit-refused:${id}:${new Date().toISOString().slice(0, 13)}`,
      subject: `RETURN SUBMIT REFUSED — order ${id}`,
      body: [
        `The customer pressed submit on order ${id} and it was refused before`,
        `anything was booked or charged (${reason}). The portal told them why.`,
        ``,
        `Payout sent by the browser: ${isCredit === null ? "none" : isCredit ? "store credit" : "card refund"}`,
        ``,
        `Check whether they retried successfully (a return_submissions row`,
        `after this alert). If not, reach out.`,
      ].join("\n"),
    });
  } catch (alertError) {
    console.error("Could not queue the submit-refused alert:", alertError);
  }
}

export async function submitReturnHandler(
  ctx: CustomerContext,
  input: Omit<z.infer<typeof submitReturnInput>, "expectedOrderId">
): Promise<HandlerResult<{ navigate: string }, SubmitReturnRefusal>> {
  const id = ctx.orderId;
  const isCredit = input.payout === null ? null : input.payout === "credit";

  // Before the payment branch, so it covers BOTH outcomes: the free path
  // continues below, and the paid path goes to Stripe and comes back through
  // the webhook, which reads the column from the database.
  await persistOrderLocale(id);

  // Resolved and persisted before createStripeUrl for the same reason as the
  // locale above: the webhook has no session and no client state, so the row
  // is the only channel that survives the redirect.
  let method = await decideMethod(id, input.method);
  // If the write did not land, the webhook cannot know the customer chose SELF
  // — it will read a null column and book the address-derived lane. Pricing
  // must follow the lane we will actually book, or the customer pays the
  // outbound leg only and then gets a full Correos/Amphora booking on top.
  if (!(await persistReturnMethod(id, method)) && method === "SELF") {
    const order = await getOrderById(id);
    method = defaultMethodFor(order?.shippingCountry, process.env.AMPHORA_INTL_RETURNS_ENABLED === "true");
  }

  // Whether the customer owes anything is decided server-side, inside
  // createStripeUrl, which also saves the agreement as a submission. A null
  // URL means nothing to pay; the submission is then accepted right here.
  const checkout = await createStripeUrl(id, isCredit, method);
  if (!checkout.ok) {
    await alertSubmitRefused(id, isCredit, checkout.reason);
    if (checkout.reason === "payout-required") {
      // The server's basket is the truth, and this tab's may be stale (another
      // tab changed the selection). Revalidating sends the stored selection
      // back with this same response, so the portal re-derives "is a payout
      // owed" from the data the server just refused on, not from its own copy.
      revalidatePath("/", "layout");
    }
    return refuse(checkout.reason);
  }
  if (checkout.url) return ok({ navigate: checkout.url });

  const submission = checkout.submission;
  try {
    // Nothing to pay.
    if (!(await acceptFreeSubmission(submission))) {
      throw new Error(`submission ${submission.id} could not be accepted (no longer awaiting)`);
    }
    // First update the database
    await confirmSubmission(submission);
    // Then create the return shipment (Correos label, Amphora collection, or self-booked)
    const statusLabel = await createReturnShipment(id, method);
    if (statusLabel !== 200) {
      // If label creation fails, undo database changes
      await revertFinalOrder(id);
      console.error("Failed to create shipping label");
      await alertReturnWithoutLabel(id, `carrier booking returned ${statusLabel}`);
    }
  } catch (error) {
    console.error("Error in order processing:", error);
    const detail = error instanceof Error ? error.message : String(error);
    // Attempt to undo database changes if there was an error
    try {
      await revertFinalOrder(id);
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
  return ok({ navigate: "/success" });
}
