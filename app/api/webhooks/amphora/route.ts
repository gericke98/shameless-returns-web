import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import axios from "axios";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getOrderById, getOrderByNumber } from "@/db/queries";
import {
  buildCollectionScheduledEmail,
  buildReturnReceivedEmail,
} from "@/lib/emails";
import { exchangeFromProducts } from "@/lib/exchange";
import { readLocale } from "@/lib/i18n";
import {
  decideWebhookActions,
  orderIdFromWebhook,
  type AmphoraWebhookReturn,
} from "@/lib/amphoraWebhook";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/**
 * Amphora return-status webhooks.
 *
 * Amphora assigns the carrier asynchronously, long after the request that
 * created the return has ended — so without this endpoint the promise made in
 * the collection email ("we will email you the tracking details as soon as the
 * collection is scheduled") can never be kept.
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

async function sendEmail(payload: Record<string, unknown>): Promise<number> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return 500;
  try {
    const res = await axios.post(POSTMARK_API_URL, payload, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
    });
    return res.status;
  } catch (error: any) {
    console.error(
      "Amphora webhook email error:",
      error?.response?.data || error?.message || error
    );
    return 500;
  }
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
    (id ? await getOrderById(id) : null) ??
    (payload.name ? await getOrderByNumber(payload.name) : null);

  if (!order) {
    console.log(
      `[amphora-webhook] no local order for ${payload.id ?? payload.name} — ignoring`
    );
    return NextResponse.json({ message: "ignored" });
  }

  const actions = decideWebhookActions(order, payload);
  if (actions.noop || !actions.persist) {
    return NextResponse.json({ message: "no-op" });
  }

  // Persist BEFORE emailing. A redelivery then finds the status unchanged and
  // does nothing, so the customer can never be emailed twice. The cost is that
  // a failed email is not retried — hence the loud log below.
  await db.update(orders).set(actions.persist).where(eq(orders.id, order.id));

  const locale = readLocale(order.locale);
  const exchange = exchangeFromProducts((order as any).products);

  for (const email of actions.emails) {
    const built =
      email === "collectionScheduled"
        ? buildCollectionScheduledEmail(
            order.shippingName,
            locale,
            { number: payload.carrier_number, url: payload.carrier_url },
            exchange
          )
        : buildReturnReceivedEmail(order.shippingName, locale, exchange);

    const status = await sendEmail({
      ...built,
      To: order.email,
      MessageStream: "outbound",
    });
    if (status !== 200) {
      console.error(
        `[amphora-webhook] order ${order.id}: status saved as ${actions.persist.returnStatus} but the "${email}" email FAILED (${status}). Customer needs a manual notice.`
      );
    }
  }

  if (
    payload.internal_status === "EXCEPTION" ||
    payload.internal_status === "EXCEPTION_WAREHOUSE"
  ) {
    console.error(
      `[amphora-webhook] order ${order.id} (${order.orderNumber}) entered ${payload.internal_status} — needs manual attention.`
    );
  }

  return NextResponse.json({ message: "ok" });
}
