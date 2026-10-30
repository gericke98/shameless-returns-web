import { NextResponse } from "next/server";
import { sweepReceiptShortfalls } from "@/actions/receiptShortfallSweep";
import { enqueueOpsAlerts } from "@/actions/opsAlertOutbox";

/**
 * Detect short receipts and queue their ops alerts.
 *
 * Its own route and budget, not part of auto-approve (daily, capped, dry-mode
 * coupled) nor amphora-sync (already near its budget). Alerts it queues are
 * delivered by /api/cron/ops-alerts. It never moves money or emails a customer.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Same fail-closed rule as the other crons: unset secret = closed. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await sweepReceiptShortfalls());
  } catch (error: any) {
    // An upstream read failed (Amphora, Shopify, the database): nothing was
    // decided, nothing opened or resolved. The next run starts over.
    const detail = String(error?.message || error);
    console.error("[receipt-shortfalls] sweep failed:", detail);
    // A sweep that keeps failing detects nothing, silently. One alert per UTC
    // day of failure: loud enough to notice, not every 15 minutes.
    const day = new Date().toISOString().slice(0, 10);
    await enqueueOpsAlerts([
      {
        dedupeKey: `receipt-shortfalls-failing:${day}`,
        subject: `[returns] SHORT-RECEIPT SWEEP FAILING (${day})`,
        body: [
          `The short-receipt sweep failed, so no short receipt is being detected or alerted.`,
          ``,
          `First error today: ${detail}`,
          ``,
          `It runs every 15 minutes. A schema error usually means drizzle/0005_receipt_shortfalls.sql`,
          `(or 0004_ops_alerts.sql) was never applied to ShamelessReturns.`,
        ].join("\n"),
      },
    ]);
    return NextResponse.json({ error: "sweep failed" }, { status: 502 });
  }
}
