import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getOrderByIdFresh, getOrderByNumberFresh } from "@/db/queries";
import { applyReturnStatus } from "@/actions/amphoraStatusSync";
import {
  orderIdFromWebhook,
  type AmphoraWebhookReturn,
} from "@/lib/amphoraWebhook";

/**
 * Amphora return-status webhooks.
 *
 * Amphora assigns the carrier after the request that created the return has
 * ended, so without a status channel the promise made in the collection email
 * ("we will email you the tracking details as soon as the collection is
 * scheduled") can never be kept.
 *
 * NOTE: as of 2026-07-30 Amphora has NOT registered this endpoint, so it has
 * never fired. `app/api/cron/amphora-sync` polls for the same transitions and
 * shares the apply-step in `actions/amphoraStatusSync.ts` — that is what
 * actually keeps the promise today. Keep both: whichever notices first wins,
 * and the second is a no-op.
 *
 * PUBLIC and not cookie-authenticated: `middleware.ts` matches only /dashboard
 * and /login. The shared `X-Secret` is the ONLY thing in front of this
 * endpoint, so it is checked before any parsing or database access.
 */
function authorized(req: Request): boolean {
  const expected = process.env.AMPHORA_WEBHOOK_SECRET;
  // An unconfigured deployment must be CLOSED, not open.
  if (!expected) return false;

  const got = req.headers.get("x-secret");
  if (!got) return false;

  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first; the comparison stays constant-time for equal-length inputs.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { fulfillment_return?: AmphoraWebhookReturn };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const payload = body?.fulfillment_return;
  if (!payload) {
    return NextResponse.json(
      { error: "Missing fulfillment_return" },
      { status: 400 }
    );
  }

  // Returns created through Amphora's own Shopify channel fire these webhooks
  // too. They are not ours — and a non-200 would have Amphora retry an
  // unmatchable event forever, so an unknown order is a 200.
  const id = orderIdFromWebhook(payload);
  const order =
    (id ? await getOrderByIdFresh(id) : null) ??
    (payload.name ? await getOrderByNumberFresh(payload.name) : null);

  if (!order) {
    console.log(
      `[amphora-webhook] no local order for ${payload.id ?? payload.name} — ignoring`
    );
    return NextResponse.json({ message: "ignored" });
  }

  const outcome = await applyReturnStatus(order as any, payload);
  return NextResponse.json({ message: outcome.changed ? "ok" : "no-op" });
}
