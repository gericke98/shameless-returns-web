import { NextResponse } from "next/server";
import { recoverSettlements } from "@/lib/settlement/recovery";

/**
 * Move every settlement operation nobody is moving (S2 plan L5): pending ones
 * whose dependency is done, claims whose lease ran out, dispatches unanswered
 * for over 10 minutes; re-finalize lines whose operations are all done; alert
 * on cancellations that never finished.
 *
 * Gated by CRON_SECRET only. The auto-approve gate, its cap and
 * AUTO_APPROVE_ENABLED decide what is ADMITTED; once admitted, an operation
 * is finished here whatever they say.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Stop starting new operations this far in, so the one in flight can record. */
const BUDGET_MS = 200_000;

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
    return NextResponse.json(await recoverSettlements({ deadline: Date.now() + BUDGET_MS }));
  } catch (error: any) {
    console.error("[settlement-recovery] failed:", error?.message || error);
    return NextResponse.json({ error: "recovery failed" }, { status: 500 });
  }
}
