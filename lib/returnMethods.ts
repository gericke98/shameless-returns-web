// Pure — no db, no env, no network. Which shipping lanes a return may use, and
// which of them the customer is allowed to pick, so the whole matrix is
// testable without standing up an order or a carrier.

import { isInternationalOrder } from "@/lib/countries";

export type ReturnMethod = "CORREOS" | "AMPHORA" | "SELF";

/**
 * The lane we would choose for this order if the customer expressed no
 * preference — i.e. exactly what `createReturnShipment` did before self-booking
 * existed. Kept identical on purpose: with no SELF claim, behaviour must not
 * change for anybody.
 */
export function defaultMethodFor(
  country: string | null | undefined,
  amphoraEnabled: boolean
): ReturnMethod {
  return isInternationalOrder(country) && amphoraEnabled ? "AMPHORA" : "CORREOS";
}

/**
 * Self-booking is offered only where our own return leg costs the customer
 * something. Where our label is already free it could only cost them more, and
 * it would generate untracked parcels for no benefit.
 */
export function selfBookingOffered(returnLegCents: number): boolean {
  return returnLegCents > 0;
}

/**
 * The lane to actually use, given what the client claimed.
 *
 * SELF is the ONLY method a customer may choose. Everything else is decided by
 * their address, so a claim of "CORREOS" or "AMPHORA" is either noise or an
 * attempt to book a lane we do not run for that country — both are ignored in
 * favour of the default.
 *
 * The fee is re-derived from the RESULT of this function, never from the claim,
 * which is what stops a client asking for SELF on a free return to shed the
 * return leg of an exchange.
 */
export function resolveReturnMethod(
  claimed: unknown,
  country: string | null | undefined,
  amphoraEnabled: boolean,
  returnLegCents: number
): ReturnMethod {
  const fallback = defaultMethodFor(country, amphoraEnabled);
  if (claimed !== "SELF") return fallback;
  return selfBookingOffered(returnLegCents) ? "SELF" : fallback;
}
