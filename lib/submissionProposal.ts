// Build the agreement for an order's current selection and save it as a
// submission. Shared by checkout (actions/payments.ts) and by the webhook for
// a session created before submissions existed.
//
// Deliberately NOT a "use server" module: every export of one is a callable
// endpoint, and this writes money terms for any order id it is given. Callers
// gate access themselves.
import { getFeeTable } from "@/db/fees";
import { getOrderTotal } from "@/db/queries";
import {
  proposeSubmission,
  recordLegacySubmission,
  type SubmissionLineInput,
} from "@/db/submissions";
import { buildAgreement, type Agreement } from "@/lib/agreement";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { resolveFulfillmentLineItems } from "@/lib/fulfillmentLines";
import { resolveFee } from "@/lib/fees";
import { loadBasket } from "@/lib/loadBasket";
import type { ReturnMethod } from "@/lib/returnMethods";

export type Proposal = {
  submissionId: string;
  agreement: Agreement;
  loaded: NonNullable<Awaited<ReturnType<typeof loadBasket>>>;
};

/**
 * The agreement for the order's current selection, and each line's identity:
 * its row, its Shopify line item and — resolved here, before anything is paid
 * — the fulfillment line item the Shopify return will name.
 *
 * Null when the order is gone or nothing is selected. Throws when a selected
 * line has no fulfillment line item: it was never shipped, so there is nothing
 * to send back, and agreeing terms for it would charge for a return that
 * cannot be made.
 */
async function currentAgreement(orderId: string, isCredit: boolean, method: ReturnMethod) {
  const loaded = await loadBasket(orderId);
  if (!loaded || !loaded.basket.hasItems) return null;
  const { order, basket } = loaded;

  // Two legs, two zones. The parcel is collected from `order.shipping*` and
  // the replacement is delivered to the delivery address, which is the same
  // place unless the customer named a different one.
  const legs = feeLegsForOrder(await getFeeTable(), order);
  const { feeCents, returnLegCents, outboundLegCents } = resolveFee(legs, basket);

  // A self-booked return pays its own courier, so it is billed the outbound
  // leg alone. `method` has already been through resolveReturnMethod on the
  // server, so it cannot be a client claiming SELF where SELF is not offered.
  const agreement = buildAgreement({
    lines: basket.lines,
    returnLegCents,
    outboundLegCents,
    feeCents,
    selfBooked: method === "SELF",
    tender: isCredit ? "credit" : "refund",
  });

  const rowById = new Map<number, any>(
    (order.products ?? []).map((row: any) => [Number(row.id), row])
  );
  const selected = agreement.lines.map((line) => ({
    productsorderId: line.id,
    lineItemId: String(rowById.get(line.id)?.lineItemId),
  }));
  const fulfillment = await resolveFulfillmentLineItems(selected, await getOrderTotal(orderId));

  const lines: SubmissionLineInput[] = selected.map(({ productsorderId, lineItemId }) => {
    const fulfillmentLineItemId = fulfillment.get(productsorderId);
    if (!fulfillmentLineItemId) {
      throw new Error(
        `Order ${orderId}: line item ${lineItemId} (row ${productsorderId}) has no ` +
          `fulfillment line item in Shopify — it cannot be returned`
      );
    }
    const row = rowById.get(productsorderId);
    return {
      productsorderId,
      shopifyLineItemId: lineItemId,
      fulfillmentLineItemId,
      newVariantId: row?.new_variant_id ?? null,
      reason: row?.reason ?? null,
      notes: row?.notes ?? null,
    };
  });
  return { agreement, loaded, lines };
}

/**
 * Save the current selection as a submission awaiting payment, superseding
 * any earlier one. Null when there is nothing to submit. Throws when another
 * submission for the same order is being saved at the same instant (a double
 * submit): that one carries on, and this one must not open a second checkout
 * for the same goods.
 */
export async function proposeCurrentSelection(
  orderId: string,
  isCredit: boolean,
  method: ReturnMethod
): Promise<Proposal | null> {
  const current = await currentAgreement(orderId, isCredit, method);
  if (!current) return null;
  const proposed = await proposeSubmission({
    orderId,
    returnMethod: method,
    agreement: current.agreement,
    lines: current.lines,
  });
  if (!proposed.ok) {
    throw new Error(`Order ${orderId}: a submission is already being saved`);
  }
  return { submissionId: proposed.id, agreement: current.agreement, loaded: current.loaded };
}

/**
 * A Stripe session created before submissions existed has just been paid:
 * record what it paid for — the rows as they stand, which is what confirming
 * it has always meant — already accepted. See db/submissions.ts.
 */
export async function acceptLegacySession(
  orderId: string,
  isCredit: boolean,
  method: ReturnMethod,
  session: { sessionId: string; paymentIntent: string | null }
) {
  const current = await currentAgreement(orderId, isCredit, method);
  if (!current) return null;
  return recordLegacySubmission({
    orderId,
    returnMethod: method,
    agreement: current.agreement,
    lines: current.lines,
    ...session,
  });
}
