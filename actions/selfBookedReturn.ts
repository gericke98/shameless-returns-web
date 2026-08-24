"use server";

import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getOrderByIdFresh, getVariantSkusByIds } from "@/db/queries";
import { amphoraOrderIdFromShopifyId, createAmphoraReturn } from "./amphora";
import { alertOps } from "./opsAlert";
import { sendSelfReturnInstructions } from "@/actions/selfReturnEmails";
import { readLocale } from "@/lib/i18n";

/**
 * The submit half of a self-booked return.
 *
 * Books nothing. The customer is arranging their own courier, so there is no
 * Correos pre-registration and no Amphora collection — only a record that a
 * parcel is coming, and instructions telling them where to send it.
 *
 * The Amphora ticket is created WITHOUT `auto_approve` and deliberately left at
 * PENDING. Approving is what dispatches a courier, and it also pins
 * `carrier_number` write-once — we cannot fill that in until the customer has
 * been to the post office and has a tracking number to give us. A later task
 * approves the ticket once that tracking number exists.
 *
 * Returns an HTTP-style status to mirror `createShippingLabel` and
 * `createInternationalReturn`, so `createReturnShipment` can treat all three
 * lanes identically.
 */
export async function createSelfBookedReturn(id: string): Promise<number> {
  // Deliberately NOT `getOrderById` — that is wrapped in React `cache()` and
  // would serve a stale row (from an earlier read in this warm serverless
  // instance) to a second submit arriving right behind the first, defeating
  // the idempotency guard below. `db/queries.ts` documents a real incident of
  // exactly this staleness reaching production. `submitReturnTracking` reads
  // fresh for the same reason — the two guards must not disagree.
  const order = await getOrderByIdFresh(id);
  if (!order) return 404;

  // Idempotency, the same guard the other two lanes apply: a resubmit must not
  // open a second warehouse ticket for one parcel.
  if ((order as any).returnSubmittedAt) {
    console.warn(
      `Order ${id}: self-booked return already submitted — skipping (duplicate submit).`
    );
    return 200;
  }

  await db
    .update(orders)
    .set({ returnMethod: "SELF", returnSubmittedAt: new Date() })
    .where(eq(orders.id, id));

  // Everything past this point is best-effort and must not fail the return:
  // the customer's return exists the moment the row above is written, and
  // reporting failure would revert a live Shopify return. Swallowed, but never
  // silently — order #311174 went eight days unnoticed exactly that way, and
  // #311329 was mis-triaged because an earlier alert here overstated the
  // damage. Say precisely what happened, not what usually happens.
  try {
    const returned = ((order as any).products ?? []).filter(
      (p: any) => p.action !== "CAMBIO" || p.new_variant_id
    );
    const skusById = await getVariantSkusByIds(
      returned.map((p: any) => String(p.variant_id))
    );
    const items = returned
      .map((p: any) => ({
        sku: skusById[String(p.variant_id)],
        quantity: Number(p.quantity) || 1,
      }))
      .filter((i: any) => i.sku);

    if (items.length === 0) {
      throw new Error("no SKUs resolved for the returned lines");
    }

    await createAmphoraReturn({
      orderId: amphoraOrderIdFromShopifyId(order.id),
      items,
      externalId: order.id,
      time: new Date().toISOString(),
      name: order.orderNumber,
      customerEmail: order.email,
      // NOT auto-approved, and NOT approved below. See above.
    });
  } catch (error: any) {
    await alertOps(
      `[returns] SELF RETURN NOT PRE-REGISTERED — ${order.orderNumber}`,
      [
        `A customer is posting a parcel the warehouse does not know about.`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        `Country:   ${order.shippingCountry}`,
        ``,
        `Failure:   ${error?.response?.data || error?.message || error}`,
        ``,
        `The return itself is fine — the row is written and the customer will`,
        `still be emailed where to send the parcel. Only the Amphora ticket is`,
        `missing. Open it by hand (EXTERNAL, no auto_approve) so the warehouse`,
        `is expecting the parcel when it lands.`,
      ].join("\n")
    );
  }

  const emailStatus = await sendSelfReturnInstructions(
    order.email,
    order.shippingName,
    readLocale(order.locale),
    order.id
  );
  if (emailStatus !== 200) {
    await alertOps(
      `[returns] SELF RETURN, NO INSTRUCTIONS — ${order.orderNumber}`,
      [
        `A self-booked return was created and the customer was not told where`,
        `to send the parcel (Postmark call returned ${emailStatus}).`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        ``,
        `They chose to ship it themselves and now have no address and no link`,
        `to submit tracking. Send them the instructions by hand.`,
      ].join("\n")
    );
  }

  return 200;
}
