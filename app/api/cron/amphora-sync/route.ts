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
// ⚠️ THE SCHEDULE IN vercel.json IS EMPTY — this poller is PAUSED (2026-08-11).
// In production it reported every return as changed on every run, an hour
// apart, with the statuses it had written already in the database, while the
// identical decision replayed locally against that same database and Amphora
// payload no-opped for all fifteen. So the deployed route is not reading what
// the database holds, and the cause is not yet known.
//
// Harmless while nothing is RECEIVED: collectionScheduled is disarmed by the
// stored locator, so every run sent zero emails. NOT harmless after that —
// returnReceived fires on RECEIVED and is guarded ONLY by that comparison, so
// the first return to reach it would email the customer every fifteen minutes.
// Three were PROCESSING_WAREHOUSE when this was paused, one step away.
//
// Restore `{"path": "/api/cron/amphora-sync", "schedule": "*/15 * * * *"}` once
// the read is understood AND a durable guard exists that does not depend on it.
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

/**
 * Did this order ever produce a return through OUR portal?
 *
 * A row in `orders` proves nothing: `actions/order.ts` saves the order the
 * moment a customer successfully looks up a number + email, before anything is
 * started, paid for or booked. Plenty of international customers opened the
 * portal, abandoned it, and returned through customer service instead.
 *
 * A confirmed line item is the real signal — it is what `getReturns` uses to
 * decide something is a return at all. `getOrderById` already loads
 * `with: { products: true }`, so this costs no extra query.
 *
 * Deliberately NOT `order.locator != null` / `order.carrier != null`: a return
 * we created that Amphora never assigned a carrier to has a null locator, which
 * is exactly the stranded-then-re-created case this whole sync exists to catch.
 * That test would have excluded all seven of the returns that motivated it.
 */
function hasConfirmedReturn(order: { products?: Array<{ confirmed?: boolean | null }> }): boolean {
  return (order.products ?? []).some((p) => p.confirmed === true);
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
  let skippedNoReturn = 0;

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
      // a return against a domestic order is never ours to apply.
      //
      // This is checked for EVERY match, `external_id` ones included. We create
      // Amphora returns for international orders only — `actions/return.ts` and
      // the Stripe webhook both gate on `isInternationalOrder` — so it is
      // already true by construction for anything we created, and applying it
      // unconditionally costs nothing while removing our dependence on Amphora
      // never populating `external_id` themselves. The Correos tracking a
      // Spanish customer is actively watching is what this protects.
      if (!isInternationalOrder(order.shippingCountry)) {
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

      // International is not enough for an orphan. Being in `orders` only means
      // this customer once opened the portal for this order — see
      // hasConfirmedReturn. Without this, order #310500 (France, looked up in
      // March, abandoned, returned via customer service) gets Amphora's own
      // warehouse-arrival record applied to it months later, and the customer
      // is sent BOTH a "your collection is scheduled" and a "we've received
      // your return" email for a return we never managed.
      //
      // Scoped to orphans: an `external_id` is a direct statement that we
      // created the return through the API, which is stronger evidence than a
      // confirmed line item, and the portal is not the only path to one.
      if (!match.viaExternalId && !hasConfirmedReturn(order)) {
        skipped += 1;
        skippedNoReturn += 1;
        continue;
      }

      scanned += 1;
      acted.push(match);

      // TEMPORARY DIAGNOSTIC (2026-08-11). Production reports every return as
      // changed on every run, while the same decision replayed locally against
      // the same database and the same Amphora data no-ops for all of them. So
      // what this route reads is not what the database holds — print it. Remove
      // once the cause is found; runtime logs live about an hour, so trigger a
      // run and read them straight away.
      console.log(
        `[amphora-sync][diag] ${ret.name}: read returnStatus=${JSON.stringify(
          (order as any).returnStatus
        )} locator=${JSON.stringify((order as any).locator)} vs amphora=${JSON.stringify(
          ret.internal_status
        )} (row id ${(order as any).id})`
      );

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
  const strandedMatches = acted.filter(
    (m) => !m.ret.carrier && !["CANCELLED", "FINISHED"].includes(String(m.ret.internal_status))
  );
  const stranded = strandedMatches.length;
  if (stranded) {
    // Name them. A bare count in the Vercel logs tells whoever is on call that
    // something is wrong but not which customer is waiting, which means going
    // back to the Amphora UI to find out — the delay this sync exists to end.
    const names = strandedMatches
      .map((m) => m.ret.name ?? m.ret.id ?? "(unnamed)")
      .join(", ");
    console.warn(
      `[amphora-sync] ${stranded} return(s) approved with no carrier assigned — collections are not booked: ${names}`
    );
  }

  return NextResponse.json({
    scanned,
    changed,
    stranded,
    skipped,
    skippedUnknownCountry,
    skippedNoReturn,
  });
}
