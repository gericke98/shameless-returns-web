import { NextResponse } from "next/server";
import { getAmphoraReturns } from "@/actions/amphora";
import { applyReturnStatus } from "@/actions/amphoraStatusSync";
import { getOrderById, getOrderByNumber } from "@/db/queries";
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";
import { isInternationalOrder } from "@/lib/countries";

/**
 * Poll Amphora for return-status changes and act on them.
 *
 * This exists because Amphora has never registered our webhook
 * (`app/api/webhooks/amphora`), so the push channel has never delivered a
 * single event. Without this, a customer who paid for a collection is told
 * nothing when the carrier is finally assigned — which is exactly the promise
 * the confirmation email makes.
 *
 * Both paths funnel through `applyReturnStatus`, whose decision function
 * no-ops on an unchanged status and only sends `collectionScheduled` while we
 * hold no locator. So this is safe to run frequently, safe to run alongside the
 * webhook if Amphora ever enables it, and cannot double-email.
 */
export const maxDuration = 60;
// Always hit Amphora; a cached response would defeat the point.
export const dynamic = "force-dynamic";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret =
 *  closed, never open, since this route writes and sends customer email. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let returns;
  try {
    returns = await getAmphoraReturns();
  } catch (error: any) {
    console.error(
      "[amphora-sync] could not list returns:",
      error?.response?.data || error?.message || error
    );
    return NextResponse.json({ error: "Amphora unreachable" }, { status: 502 });
  }

  // Which order does each return refer to, at most one return per order?
  const matches = matchReturnsToOrderIds(returns);

  const changed: Array<Record<string, unknown>> = [];
  const acted: typeof matches = [];
  let scanned = 0;
  let skipped = 0;
  let skippedUnknownCountry = 0;

  for (const match of matches) {
    const ret = match.ret;
    try {
      const order =
        (await getOrderById(match.orderId)) ??
        (match.viaExternalId && ret.name ? await getOrderByNumber(ret.name) : null);

      if (!order) {
        // No local order at all for this id — expected and common (Amphora's
        // Shopify-channel returns and arrival records for orders we don't
        // recognise). Nothing to warn about.
        skipped += 1;
        continue;
      }

      // An id match is not ownership. A return Amphora created carries no
      // external_id, and neither does the record Amphora opens when a parcel
      // simply ARRIVES at their warehouse — which happens for domestic returns
      // too, since they are the 3PL receiving every box. Measured 2026-08-05:
      // 47 of the 87 returns we did not create are Spanish, carrying CEX/CAI/
      // GLS/CTT. Order #310273 is the case that matters: we booked it on
      // Correos and hold locator PQAZXT9800004100128221Y, while Amphora's
      // record for the same parcel says carrier CEX. Syncing a domestic orphan
      // would overwrite the Correos tracking we show the customer with the
      // carrier that happened to deliver it. Spain is Correos on our side, so
      // an orphan against a domestic order is never ours to apply.
      if (!match.viaExternalId && !isInternationalOrder(order.shippingCountry)) {
        skipped += 1;

        // isInternationalOrder treats an empty/missing shippingCountry as
        // domestic — the safe direction, since we must never act without
        // knowing the country. But that makes it indistinguishable from a
        // genuine Spanish reject unless we say so: a live international
        // return with no country on file would be silently under-matched,
        // which is the exact bug this task exists to fix. The column is
        // NOT NULL and db/repository.ts writes it straight from Shopify, so
        // this should be rare — log it so rare-and-invisible doesn't happen
        // again.
        if (!String(order.shippingCountry ?? "").trim()) {
          skippedUnknownCountry += 1;
          console.warn(
            `[amphora-sync] order ${order.orderNumber ?? match.orderId} (return ${ret.id}) has no shippingCountry on file — skipped as domestic, but this may be a live international return we are failing to sync.`
          );
        }
        continue;
      }

      scanned += 1;
      acted.push(match);

      const outcome = await applyReturnStatus(order as any, {
        id: ret.id,
        name: ret.name,
        internal_status: ret.internal_status,
        carrier: ret.carrier,
        carrier_number: ret.carrier_number,
        carrier_url: ret.carrier_url,
      });

      if (outcome.changed) {
        changed.push({
          order: ret.name,
          status: outcome.status,
          emailsSent: outcome.emailsSent,
          emailsFailed: outcome.emailsFailed,
        });
        console.log(
          `[amphora-sync] ${ret.name}: -> ${outcome.status}` +
            (outcome.emailsSent.length ? ` (emailed ${outcome.emailsSent.join(", ")})` : "")
        );
      }
    } catch (error: any) {
      // One bad return must not stop the sweep — the others are still owed
      // their notifications.
      console.error(
        `[amphora-sync] ${ret.name ?? ret.id} failed:`,
        error?.message || error
      );
    }
  }

  // Visibility on the live defect: ours reach APROVED and then sit with no
  // carrier, so no collection is ever scheduled.
  const stranded = acted.filter(
    (m) => !m.ret.carrier && !["CANCELLED", "FINISHED"].includes(String(m.ret.internal_status))
  ).length;
  if (stranded) {
    console.warn(
      `[amphora-sync] ${stranded} return(s) approved with no carrier assigned — collections are not booked.`
    );
  }

  return NextResponse.json({ scanned, changed, stranded, skipped, skippedUnknownCountry });
}
