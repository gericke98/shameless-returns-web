import { NextResponse } from "next/server";
import { getAmphoraReturns } from "@/actions/amphora";
import { applyReturnStatus } from "@/actions/amphoraStatusSync";
import { getOrderById, getOrderByNumber } from "@/db/queries";

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

  // Only ours. Amphora's Shopify-channel returns have a null external_id and
  // are managed entirely on their side.
  const ours = returns.filter((r) => r.external_id);

  const changed: Array<Record<string, unknown>> = [];
  let scanned = 0;

  for (const ret of ours) {
    scanned += 1;
    try {
      const order =
        (await getOrderById(String(ret.external_id))) ??
        (ret.name ? await getOrderByNumber(ret.name) : null);
      if (!order) continue;

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
  const stranded = ours.filter(
    (r) => !r.carrier && !["CANCELLED", "FINISHED"].includes(r.internal_status)
  ).length;
  if (stranded) {
    console.warn(
      `[amphora-sync] ${stranded} return(s) approved with no carrier assigned — collections are not booked.`
    );
  }

  return NextResponse.json({ scanned, changed, stranded });
}
