// Build the agreement for an order's current selection and save it as a
// submission, for checkout (actions/payments.ts).
//
// Deliberately NOT a "use server" module: every export of one is a callable
// endpoint. It writes money terms, so it takes a `VerifiedOrderId` (F1): only
// a caller holding a credential for the order can reach it.
import { getFeeTable } from "@/db/fees";
import { getOrderTotal } from "@/db/queries";
import type { SubmissionLineInput } from "@/db/submissions";
import type { VerifiedOrderId, VerifiedSubmission } from "@/lib/server/identity";
import { proposeSubmission } from "@/lib/server/submissionScope";
import { acceptCoverage } from "@/lib/settlement/stockGate";
import type { Agreement } from "@/lib/agreement";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { resolveFulfillmentLineItems } from "@/lib/fulfillmentLines";
import { loadBasket } from "@/lib/loadBasket";
import type { ReturnMethod } from "@/lib/returnMethods";
import { selectionTerms, tenderFromIsCredit } from "@/lib/selectionTerms";

export type Proposal = {
  submission: VerifiedSubmission;
  agreement: Agreement;
  loaded: NonNullable<Awaited<ReturnType<typeof loadBasket>>>;
};

/** Why there is no agreement to save. Values, not throws: the customer can act on each. */
export type ProposalRefusal =
  | "nothing-selected"
  | "payout-required"
  | "submission-in-progress"
  /** FX §#1: Amphora cannot cover an exchange line of the agreement. */
  | "replacement-unavailable"
  /** FX §#1: Amphora could not be read; nothing was saved. */
  | "stock-unreadable";

/**
 * The agreement for the order's current selection, and each line's identity:
 * its row, its Shopify line item and — resolved here, before anything is paid
 * — the fulfillment line item the Shopify return will name.
 *
 * `nothing-selected` when the order is gone or nothing is selected;
 * `payout-required` when money comes back and no payout was chosen. Throws
 * when a selected line has no fulfillment line item: it was never shipped, so
 * there is nothing to send back, and agreeing terms for it would charge for a
 * return that cannot be made.
 */
async function currentAgreement(orderId: VerifiedOrderId, isCredit: boolean | null, method: ReturnMethod) {
  const loaded = await loadBasket(orderId);
  if (!loaded || !loaded.basket.hasItems) return { ok: false as const, reason: "nothing-selected" as const };
  const { order, basket } = loaded;

  // Two legs, two zones. The parcel is collected from `order.shipping*` and
  // the replacement is delivered to the delivery address, which is the same
  // place unless the customer named a different one.
  const legs = feeLegsForOrder(await getFeeTable(), order);

  // The same function the portal decides its payout step from, so the two
  // cannot disagree about whether a choice is owed. `method` has already been
  // through resolveReturnMethod on the server, so it cannot be a client
  // claiming SELF where SELF is not offered.
  const terms = selectionTerms(basket, legs, method, tenderFromIsCredit(isCredit));
  // The payout is the customer's choice, never a default (#312385). When money
  // comes back it must have been made explicitly; when nothing comes back the
  // tender moves no money and the portal shows no choice.
  if (!terms.agreement) return { ok: false as const, reason: "payout-required" as const };
  const agreement = terms.agreement;

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
  return { ok: true as const, agreement, loaded, lines };
}

/**
 * Save the current selection as a submission awaiting payment, superseding
 * any earlier one. `submission-in-progress` when another submission for the
 * same order is being saved at the same instant (a double submit): that one
 * carries on, and this one must not open a second checkout for the same goods.
 */
export async function proposeCurrentSelection(
  orderId: VerifiedOrderId,
  isCredit: boolean | null,
  method: ReturnMethod
): Promise<{ ok: true; proposal: Proposal } | { ok: false; reason: ProposalRefusal }> {
  const current = await currentAgreement(orderId, isCredit, method);
  if (!current.ok) return current;

  // FX §#1, bound to the exact agreement about to be saved (Codex #1): its
  // exchange lines, with each line's replacement as persisted, against
  // Amphora — BEFORE anything is proposed or charged.
  const replacementOf = new Map(current.lines.map((l) => [l.productsorderId, l.newVariantId]));
  const basket = current.agreement.lines
    .filter((l) => l.action === "CAMBIO")
    .map((l) => ({ variantGid: String(replacementOf.get(l.id) ?? ""), quantity: l.quantity }));
  if (basket.length > 0) {
    const coverage = await acceptCoverage(basket);
    if (coverage.kind === "unreadable") return { ok: false, reason: "stock-unreadable" };
    if (coverage.kind === "short") return { ok: false, reason: "replacement-unavailable" };
  }

  const proposed = await proposeSubmission(orderId, {
    returnMethod: method,
    agreement: current.agreement,
    lines: current.lines,
  });
  if (!proposed.ok) return { ok: false, reason: "submission-in-progress" };
  return {
    ok: true,
    proposal: { submission: proposed.submission, agreement: current.agreement, loaded: current.loaded },
  };
}
