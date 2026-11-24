// Tell Amphora about a self-booked return's tracking. Server-only, NOT a
// "use server" module (every export of one is a callable endpoint).
//
// Called ONLY for a number that is verified: by the carrier at submit
// (actions/selfBookedTracking) or by an admin in the dashboard
// (actions/selfTrackingReview). carrier_number and carrier_url are pinned
// WRITE-ONCE at approve, so the caller has already won the database claim
// that makes this the only call for the order.
import { amphoraOrderIdFromShopifyId, approveAmphoraReturn } from "@/actions/amphora";
import { alertOps } from "@/actions/opsAlert";
import { describeError } from "@/lib/describeError";

export type PinnableTracking = {
  id: string;
  orderNumber: string;
  email: string | null;
  carrier: string;
  number: string;
  carrierUrl: string;
};

/**
 * Best-effort, and swallowed: the customer has done everything asked of them
 * and the parcel is already moving. Never silent, though.
 */
export async function pinSelfTracking(t: PinnableTracking): Promise<boolean> {
  try {
    await approveAmphoraReturn(amphoraOrderIdFromShopifyId(t.id), {
      carrier: t.carrier,
      carrier_number: t.number,
      carrier_url: t.carrierUrl,
    });
    return true;
  } catch (error: any) {
    await alertOps(
      `[returns] SELF RETURN NOT APPROVED — ${t.orderNumber}`,
      [
        `A verified tracking number was not accepted by the warehouse.`,
        ``,
        `Order:     ${t.orderNumber} (id ${t.id})`,
        `Customer:  ${t.email}`,
        `Carrier:   ${t.carrier}`,
        `Tracking:  ${t.number}`,
        `Link:      ${t.carrierUrl}`,
        ``,
        `Failure:   ${describeError(error)}`,
        ``,
        `We hold the tracking; Amphora does not. Approve the ticket by hand`,
        `with this carrier data. Note carrier_number is write-once, so get it`,
        `right the first time.`,
      ].join("\n")
    );
    return false;
  }
}
