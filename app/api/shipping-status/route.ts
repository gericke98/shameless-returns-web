import { NextResponse } from "next/server";
import { obtainLastStatus } from "@/actions/shipping";

export const revalidate = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const locator = searchParams.get("locator");

  if (!locator) {
    return NextResponse.json(
      { error: "Missing locator" },
      { status: 400 }
    );
  }

  const status = (await obtainLastStatus(locator)) ?? locator;

  return NextResponse.json(
    { locator, status },
    {
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=600",
      },
    }
  );
}
