import { NextResponse } from "next/server";
import { obtainLastStatus } from "@/lib/server/shipping";
import { UNKNOWN_TRACKING } from "@/lib/trackingStatus";
import { isAdmin } from "@/lib/requireAdmin";

// Admin-only (the dashboard's Status column), so never a shared-cache entry
// (F1 spec §6, blocker 16): an admin-warmed 200 cached at the edge would be
// served to an anonymous request without running the gate. Every response,
// 200, 400 and 401, is `private, no-store`, and the route always runs.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const { searchParams } = new URL(request.url);
  const locator = searchParams.get("locator");

  if (!locator) {
    return NextResponse.json({ error: "Missing locator" }, { status: 400, headers: NO_STORE });
  }

  // No `?? locator` fallback here any more. When the lookup told us nothing,
  // the response used to be the tracking NUMBER itself, which the dashboard
  // then rendered in the Status column — so an unanswerable question looked
  // like an answer. `obtainLastStatus` already reports "unknown" as a state.
  const status = (await obtainLastStatus(locator)) ?? UNKNOWN_TRACKING;

  return NextResponse.json({ locator, label: status.label, phase: status.phase }, { headers: NO_STORE });
}
