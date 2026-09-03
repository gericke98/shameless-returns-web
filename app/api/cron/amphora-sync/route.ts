import { NextResponse } from "next/server";
import { getAmphoraReturns } from "@/actions/amphora";
import { applyReturnStatus } from "@/actions/amphoraStatusSync";
import { getOrderByIdFresh, getOrderByNumberFresh } from "@/db/queries";
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";
import { isInternationalOrder } from "@/lib/countries";
import { sweepSelfReturns } from "@/actions/selfReturnSweep";
import { alertOps } from "@/actions/opsAlert";

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

/**
 * Did this order ever produce a return through OUR portal?
 *
 * A row in `orders` proves nothing: `actions/order.ts` saves the order the
 * moment a customer successfully looks up a number + email, before anything is
 * started, paid for or booked. Plenty of international customers opened the
 * portal, abandoned it, and returned through customer service instead.
 *
 * A confirmed line item is the real signal — it is what `getReturns` uses to
 * decide something is a return at all. `getOrderByIdFresh` already loads
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
  // Carries the order's lane alongside the return, because the stranded check
  // below has to exclude self-booked tickets — see there.
  const acted: Array<
    (typeof matches)[number] & { returnMethod?: string | null }
  > = [];
  let scanned = 0;
  let failed = 0;
  let firstError = "";
  let skipped = 0;
  let skippedUnknownCountry = 0;
  let skippedNoReturn = 0;

  for (const match of matches) {
    const ret = match.ret;
    try {
      const order =
        (await getOrderByIdFresh(match.orderId)) ??
        (match.viaExternalId && ret.name ? await getOrderByNumberFresh(ret.name) : null);

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
      // This is checked for EVERY match, `external_id` ones included — and it
      // is now the only thing keeping domestic rows out, because the SELF lane
      // creates Amphora tickets for DOMESTIC orders too (`createSelfBookedReturn`
      // opens one with an `external_id` whatever the country, so the warehouse
      // is expecting the parcel). It was already applied unconditionally, which
      // is why that lane needed no change here. The Correos tracking a Spanish
      // customer is actively watching is what this protects.
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
      acted.push({ ...match, returnMethod: (order as any).returnMethod });

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
      failed += 1;
      if (!firstError) firstError = String(error?.message || error);
      console.error(
        `[amphora-sync] ${ret.name ?? ret.id} failed:`,
        error?.message || error
      );
    }
  }

  // Visibility on the live defect: ours reach APROVED and then sit with no
  // carrier, so no collection is ever scheduled.
  // SELF is excluded: a self-booked international ticket sits at PENDING with
  // no carrier for up to 10 days BY DESIGN — there is no collection to book,
  // and the carrier is not known until the customer has been to the post office
  // and told us. Without this it matches on every run, so the warning the team
  // added to catch genuinely stranded collections fires every 15 minutes for a
  // return that is behaving exactly as intended.
  const strandedMatches = acted.filter(
    (m) =>
      m.returnMethod !== "SELF" &&
      !m.ret.carrier &&
      !["CANCELLED", "FINISHED"].includes(String(m.ret.internal_status))
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

  // Every single return erroring is not a bad row, it is a broken sync — and
  // until 2026-09-03 nothing here said so. PR #38 deployed with its migration
  // unapplied, every `orders` read threw, and this cron accomplished nothing
  // for ~15 hours across ~60 runs without sending a thing. It is the only
  // money-path cron that never called `alertOps`; `auto-approve` and
  // `tracking-sync` both do. Vercel drops runtime logs after about an hour, so
  // the outage was on its way to leaving no evidence at all.
  //
  // Gated on TOTAL failure, and on there being enough returns for "all of them"
  // to mean something: the per-return catch above is deliberately forgiving, so
  // a single malformed return must not page anyone every 15 minutes — that is
  // how real alerts get buried.
  const MIN_FAILURES_TO_ALERT = 3;
  if (failed >= MIN_FAILURES_TO_ALERT && failed === matches.length) {
    await alertOps(
      `[returns] AMPHORA SYNC FAILING — ${failed}/${matches.length} returns errored`,
      [
        `Every one of the ${matches.length} returns this run touched threw, so the sync did nothing.`,
        `No collection was booked and no customer was notified.`,
        ``,
        `First error: ${firstError}`,
        ``,
        `This runs every 15 minutes, so it is still failing now. A schema error here`,
        `usually means a migration was deployed but never applied — check that the`,
        `columns db/schema.ts declares actually exist on ShamelessReturns.`,
      ].join("\n")
    );
  }

  let selfReturns = { reminded: 0, alerted: 0 };
  try {
    selfReturns = await sweepSelfReturns();
  } catch (error: any) {
    // The Amphora poll above already did its work; a sweep failure must not
    // discard those results.
    console.error("[amphora-sync] self-return sweep failed:", error?.message || error);
  }

  return NextResponse.json({
    scanned,
    changed,
    stranded,
    skipped,
    skippedUnknownCountry,
    skippedNoReturn,
    selfReturns,
  });
}
