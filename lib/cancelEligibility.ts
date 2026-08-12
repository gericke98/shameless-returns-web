// Pure — no database, no cookies, no network. Every rule about when a customer
// may cancel their own return lives here, so the whole matrix is testable
// without standing up a session or a carrier.
//
// The gate matters more than usual: Correos labels cannot be voided (probed
// 2026-08-12, see docs/superpowers/specs/2026-08-12-cancel-return-design.md).
// Nothing downstream can make an unsafe cancellation safe again, so this is
// the only thing standing between a refund and a garment already in transit.

import type { CarrierMovement } from "./trackingStatus";

export type CancelBlockedReason =
  | "no-return"
  | "already-settled"
  | "in-transit"
  | "carrier-unreadable";

export type CancelDecision =
  | { cancellable: true }
  | { cancellable: false; reason: CancelBlockedReason };

/** The order fields this module reads. Structural, so callers pass their own
 *  row without reshaping it. */
export type CancellableOrder = {
  products?: Array<{ confirmed?: boolean | null; refunded?: boolean | null }> | null;
  returnStatus?: string | null;
};

/** Amphora statuses that mean the collection has already happened. Wire
 *  spelling — `APROVED` has one P and is NOT in this list. */
const MOVED_STATUSES: ReadonlyArray<string> = [
  "TRAVELLING",
  "PROCESSING_WAREHOUSE",
  "RECEIVED",
  "FINISHED",
  "FINISHED_REJECTED",
  "EXCEPTION",
  "EXCEPTION_WAREHOUSE",
];

const blocked = (reason: CancelBlockedReason): CancelDecision => ({
  cancellable: false,
  reason,
});

/**
 * May this return be cancelled?
 *
 * Order of checks is meaningful. Settlement is tested before movement so that
 * a return which is both settled and delivered reports the more final of the
 * two — telling a customer "your parcel is on its way" when we have already
 * refunded them would be worse than useless.
 */
export function cancelEligibility(
  order: CancellableOrder | null | undefined,
  movement: CarrierMovement
): CancelDecision {
  if (!order || !Array.isArray(order.products)) return blocked("no-return");

  const lines = order.products;
  if (!lines.some((line) => line?.confirmed === true)) return blocked("no-return");
  if (lines.some((line) => line?.refunded === true)) return blocked("already-settled");

  const status = order.returnStatus ?? null;
  if (status && MOVED_STATUSES.indexOf(status) !== -1) return blocked("in-transit");

  if (movement === "moved") return blocked("in-transit");
  if (movement === "unreadable") return blocked("carrier-unreadable");

  return { cancellable: true };
}
