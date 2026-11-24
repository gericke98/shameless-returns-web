// The terms of the customer's current selection: fee, agreement, and whether a
// payout choice is still owed. Pure: no db, no React, no env.
//
// ONE function for both sides. The portal decides from it whether the payout
// step exists and whether submit is allowed; the server (lib/submissionProposal)
// decides from it whether to accept the submit. Before this, the portal asked
// `calculatePrices`, which ignored the return method, while the server asked
// `buildAgreement` with it, so "Lo envío yo" could turn "nothing comes back"
// into "money comes back" on one side only (#312875 class).
import type { valueBasket } from "@/lib/basket";
import { buildAgreement, type Agreement, type Tender } from "@/lib/agreement";
import { resolveFee, type FeeLegs } from "@/lib/fees";
import type { ReturnMethod } from "@/lib/returnMethods";

export type ValuedBasket = ReturnType<typeof valueBasket>;

export type SelectionTerms = {
  /** resolveFee's answer: both legs, before the self-booked subtraction. */
  readonly fee: ReturnType<typeof resolveFee>;
  /** returned − replacement − charged fee, in cash cents. Positive: we owe. */
  readonly netCents: number;
  /** Money comes back, so the customer must choose how (#312385: never a default). */
  readonly payoutRequired: boolean;
  /**
   * The agreement for this selection, or null while a required payout has not
   * been chosen. Null is the point: a screen or a submit cannot state or agree
   * terms in a tender nobody picked — the old `credito || false` showed
   * "Reembolso tradicional" to a customer who had chosen nothing.
   */
  readonly agreement: Agreement | null;
};

export function selectionTerms(
  basket: ValuedBasket,
  legs: FeeLegs,
  method: ReturnMethod,
  payout: Tender | null
): SelectionTerms {
  const fee = resolveFee(legs, basket);
  const build = (tender: Tender) =>
    buildAgreement({
      lines: basket.lines,
      returnLegCents: fee.returnLegCents,
      outboundLegCents: fee.outboundLegCents,
      feeCents: fee.feeCents,
      // A self-booked return pays its own courier, so it is billed the
      // outbound leg alone (lib/agreement.ts).
      selfBooked: method === "SELF",
      tender,
    });

  // netCents does not depend on the tender, so the cash agreement answers
  // "is anything owed back?" without assuming a choice.
  const cash = build("refund");
  const payoutRequired = cash.netCents > 0;

  let agreement: Agreement | null;
  if (!payoutRequired) {
    // Nothing comes back: the tender moves no money and no choice is shown.
    agreement = cash;
  } else if (payout === null) {
    agreement = null;
  } else {
    agreement = payout === "refund" ? cash : build(payout);
  }

  return { fee, netCents: cash.netCents, payoutRequired, agreement };
}

/** The browser's `isCredit` as a tender: null stays null, never a default. */
export function tenderFromIsCredit(isCredit: boolean | null): Tender | null {
  if (isCredit === true) return "credit";
  if (isCredit === false) return "refund";
  return null;
}
