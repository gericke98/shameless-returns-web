import "server-only";
import { stripeClient } from "@/lib/stripe";
import { alertOps } from "@/lib/server/opsAlert";
import { centsToEuros, checkoutLines, type CheckoutLine } from "@/lib/fees";
import { dictionaries, readLocale } from "@/lib/i18n";
import type { ReturnMethod } from "@/lib/returnMethods";
import { proposeCurrentSelection, type ProposalRefusal } from "@/lib/submissionProposal";
import type { VerifiedOrderId, VerifiedSubmission } from "./identity";
import { attachStripeSession } from "./submissionScope";
import { appEnv } from "./serviceEnv";

/** Read per checkout, never at import: without the app's URL, a checkout
 *  refuses (ServiceNotConfigured) before any Stripe session exists. */
function absoluteUrl(path: string) {
  return `${appEnv().publicUrl}${path}`;
}

export type CheckoutOutcome =
  | { ok: true; url: string | null; submission: VerifiedSubmission }
  | { ok: false; reason: ProposalRefusal };

/**
 * Create a Stripe Checkout session for the amount the customer owes.
 *
 * The amount is derived here, from the order's own items and its destination
 * country. It is deliberately NOT accepted from the caller: this used to take
 * a `total` computed in the browser, which meant the page could set its own
 * price. So is the email Stripe receipts go to: the order's own, never the
 * browser's.
 *
 * Saves the submission's agreement first (lib/server/submissionScope.ts) and
 * binds the session to it. `url: null` means nothing is owed to Stripe —
 * callers must accept the submission themselves. A refusal means there is no
 * agreement to save (nothing selected, a payout owed but not chosen, or a
 * concurrent submit).
 */
export const createStripeUrl = async (
  id: VerifiedOrderId,
  isCredit: boolean | null,
  method: ReturnMethod
): Promise<CheckoutOutcome> => {
  // The agreement — what the customer is shown, what Stripe takes and what is
  // later owed — saved BEFORE any session exists, so the webhook confirms what
  // was paid for rather than whatever the rows say by then. Built by the same
  // function the portal total reads (lib/agreement.ts).
  const proposed = await proposeCurrentSelection(id, isCredit, method);
  if (!proposed.ok) return proposed;
  const { submission, agreement } = proposed.proposal;
  const { order, basket } = proposed.proposal.loaded;

  const chargeCents = agreement.chargedFeeCents;
  // netAmount is what the customer is owed; the fee reduces it. A negative
  // total means the customer owes us that much.
  const totalEuros = agreement.netCents / 100;
  const amountCents = Math.max(0, -agreement.netCents);

  if (basket.degraded) {
    if (totalEuros >= 0) {
      await alertOps(
        "EXCHANGE PRICED ON A FALLBACK — no charge",
        `Order ${id}: a replacement was priced from a fallback, not its own ` +
          `line. The customer was NOT charged — net amount computed as ` +
          `€${totalEuros.toFixed(2)} (return €${basket.netAmount.toFixed(2)} ` +
          `minus fee €${centsToEuros(chargeCents).toFixed(2)}). That total ` +
          `itself may be wrong — check the pricing, not a refund.`
      );
    } else if (amountCents < 50) {
      await alertOps(
        "EXCHANGE PRICED ON A FALLBACK — no charge",
        `Order ${id}: a replacement was priced from a fallback, not its own ` +
          `line. The amount owed, €${centsToEuros(amountCents).toFixed(2)}, is ` +
          `under Stripe's €0.50 minimum, so the customer was NOT charged. That ` +
          `total itself may be wrong — check the pricing, not a refund.`
      );
    } else {
      await alertOps(
        "EXCHANGE PRICED ON A FALLBACK — charging",
        `Order ${id}: a replacement was priced from a fallback, not its own ` +
          `line. About to charge €${centsToEuros(amountCents).toFixed(2)}. Check ` +
          `the price is right.`
      );
    }
  }

  // Nothing to collect: a refund or a break-even, or a shortfall under
  // Stripe's €0.50 minimum (per-country fees may legitimately be €0.00, which
  // makes a one-cent exchange shortfall possible). The agreement records
  // which, as `waived_cents`.
  if (agreement.stripeChargeCents === 0) return { ok: true, url: null, submission };

  // Itemise the checkout the same way the on-site summary itemises it, so the
  // customer is not asked to approve a single "fee" that silently bundles a
  // price difference and two shipping legs. checkoutLines returns [] when the
  // amount cannot be decomposed exactly, and the total is always amountCents
  // either way — this changes the description, never the charge.
  const locale = readLocale(order.locale);
  const t = dictionaries[locale];
  const LINE_LABEL: Record<CheckoutLine["kind"], string> = {
    difference: t.summary.newProducts,
    shipping: t.summary.shipping,
    returnShipping: t.summary.returnShipping,
    deliveryShipping: t.summary.deliveryShipping,
  };

  const lines = checkoutLines(
    basket,
    {
      returnLegCents: method === "SELF" ? 0 : agreement.returnLegCents,
      outboundLegCents: agreement.outboundLegCents,
    },
    agreement.stripeChargeCents
  );
  const stripeLines = lines.length
    ? lines.map((line) => ({ name: LINE_LABEL[line.kind], amountCents: line.amountCents }))
    : [{ name: "Returns & Exchanges Fee", amountCents: agreement.stripeChargeCents }];

  const isCreditMeta = isCredit ? "true" : "false";
  const returnUrl = absoluteUrl("/");
  const stripeSession = await stripeClient().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: order.email,
    line_items: stripeLines.map((line) => ({
      quantity: 1,
      price_data: {
        currency: "EUR",
        product_data: {
          name: line.name,
          description: "Shameless Collective",
        },
        unit_amount: line.amountCents,
      },
    })),
    // The submission id is what the webhook confirms: this session can only
    // ever accept THIS agreement (db/submissions.ts acceptPaidSubmission).
    client_reference_id: submission.id,
    metadata: {
      id: id,
      isCredit: isCreditMeta,
      submission_id: submission.id,
    },
    success_url: returnUrl + "/success",
    cancel_url: returnUrl,
  });
  if (!(await attachStripeSession(submission, stripeSession.id))) {
    // Superseded between the insert and now: a newer checkout owns the order.
    return { ok: false, reason: "submission-in-progress" };
  }
  return { ok: true, url: stripeSession.url, submission };
};
