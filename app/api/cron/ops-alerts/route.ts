import { NextResponse } from "next/server";
import { dispatchOpsAlerts } from "@/actions/opsAlertOutbox";

/**
 * Deliver the durable ops-alert outbox (`ops_alerts`).
 *
 * Its own route, schedule and budget on purpose: delivery must not depend on a
 * producer's work succeeding. If it ran at the end of amphora-sync, an Amphora
 * outage (which returns early) or a slow sweep eating the function budget would
 * leave queued alerts unsent while Postmark is perfectly healthy.
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
    return NextResponse.json(await dispatchOpsAlerts());
  } catch (error: any) {
    // Rows stay pending and the next run retries them. A 500 makes the failure
    // visible in Vercel's cron view rather than reporting zero sent.
    console.error("[ops-alerts] dispatch failed:", error?.message || error);
    return NextResponse.json({ error: "dispatch failed" }, { status: 500 });
  }
}
