import { NextResponse } from "next/server";
import { obtainLastStatus } from "@/actions/shipping";
import { UNKNOWN_TRACKING } from "@/lib/trackingStatus";

export const revalidate = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locator = searchParams.get("locator");

  if (!locator) {
    return NextResponse.json({ error: "Missing locator" }, { status: 400 });
  }

  // No `?? locator` fallback here any more. When the lookup told us nothing,
  // the response used to be the tracking NUMBER itself, which the dashboard
  // then rendered in the Status column — so an unanswerable question looked
  // like an answer. `obtainLastStatus` already reports "unknown" as a state.
  const status = (await obtainLastStatus(locator)) ?? UNKNOWN_TRACKING;

  return NextResponse.json(
    { locator, label: status.label, phase: status.phase },
    {
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=600",
      },
    }
  );
}
