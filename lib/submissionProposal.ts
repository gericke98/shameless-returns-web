// Build the agreement for an order's current selection and save it as a
// submission. Shared by checkout (actions/payments.ts) and by the webhook for
// a session created before submissions existed.
//
// Deliberately NOT a "use server" module: every export of one is a callable
// endpoint, and this writes money terms for any order id it is given. Callers
// gate access themselves.
import { getFeeTable } from "@/db/fees";
import { proposeSubmission } from "@/db/submissions";
import { buildAgreement, type Agreement } from "@/lib/agreement";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { resolveFee } from "@/lib/fees";
import { loadBasket } from "@/lib/loadBasket";
import type { ReturnMethod } from "@/lib/returnMethods";

export type Proposal = {
  submissionId: string;
  agreement: Agreement;
  loaded: NonNullable<Awaited<ReturnType<typeof loadBasket>>>;
};

/**
 * Null when the order is gone or nothing is selected. Throws when another
 * submission for the same order is being saved at the same instant (a double
 * submit): that one carries on, and this one must not open a second checkout
 * for the same goods.
 */
export async function proposeCurrentSelection(
  orderId: string,
  isCredit: boolean,
  method: ReturnMethod
): Promise<Proposal | null> {
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

  const proposed = await proposeSubmission({
    orderId,
    returnMethod: method,
    agreement,
    lines: (order.products ?? []).map((row: any) => ({
      productsorderId: Number(row.id),
      shopifyLineItemId: String(row.lineItemId),
      newVariantId: row.new_variant_id ?? null,
      reason: row.reason ?? null,
      notes: row.notes ?? null,
    })),
  });
  if (!proposed.ok) {
    throw new Error(`Order ${orderId}: a submission is already being saved`);
  }
  return { submissionId: proposed.id, agreement, loaded };
}
