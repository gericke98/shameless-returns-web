// Pure — no database, no cookies, no network. Decides what the success page
// should tell the customer, so the whole matrix is testable without rendering
// a page or standing up a session.
//
// It exists because `returnFunction` redirects to /success whether the return
// succeeded, failed, or threw: reaching the page proves nothing. Order #310185
// was reverted and still landed there, and the customer wrote in asking what
// she had done wrong.

/** The order fields this module reads. Structural, so callers pass their own
 *  row without reshaping it. */
export type OutcomeOrder = {
  products?: Array<{ confirmed?: boolean | null }> | null;
  locator?: string | null;
  carrier?: string | null;
  carrierUrl?: string | null;
};

export type ReturnTracking = {
  locator: string;
  carrier: string | null;
  carrierUrl: string | null;
};

export type ReturnOutcome = {
  state: "confirmed" | "missing" | "unknown";
  tracking: ReturnTracking | null;
};

const UNKNOWN: ReturnOutcome = { state: "unknown", tracking: null };
const MISSING: ReturnOutcome = { state: "missing", tracking: null };

/**
 * What actually happened to this return.
 *
 * `confirmed` is keyed off a confirmed line item — the same signal `getReturns`
 * and the sync's ownership rule use, and the one the revert clears.
 *
 * Deliberately NOT keyed off tracking: an international return Amphora has not
 * assigned a carrier to has a null locator and is entirely real. That test
 * would have reported all seven of the August stranded returns as failures.
 *
 * `unknown` is not a failure. The session that identifies the order lasts two
 * hours and a slow Stripe checkout can outlive it, so an order we cannot read
 * means "we cannot tell", and the caller must fall back to neutral copy rather
 * than alarm a customer whose return is fine.
 */
export function returnOutcome(
  order: OutcomeOrder | null | undefined
): ReturnOutcome {
  if (!order || !Array.isArray(order.products)) return UNKNOWN;

  if (!order.products.some((line) => line?.confirmed === true)) return MISSING;

  const locator = order.locator?.trim();
  return {
    state: "confirmed",
    tracking: locator
      ? {
          locator,
          carrier: order.carrier ?? null,
          carrierUrl: order.carrierUrl ?? null,
        }
      : null,
  };
}
