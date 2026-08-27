import { NextResponse } from "next/server";
import axios from "axios";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders as ordersTable } from "@/db/schema";
import { getParcelsAwaitingTracking } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import { decideTrackingUpdate } from "@/lib/trackingUpdate";
import { buildTrackingUpdateEmail } from "@/lib/emails";
import { isInternationalOrder } from "@/lib/countries";
import { readLocale } from "@/lib/i18n";
import { alertOps } from "@/actions/opsAlert";

/**
 * Tell customers where their return has got to.
 *
 * A customer books a return, gets a label, and then hears nothing — for a
 * domestic return that is literally one email at booking and silence after.
 * This closes that gap by reading Correos hourly and emailing on milestones.
 *
 * DOMESTIC ONLY. International parcels are already polled every 15 minutes by
 * `amphora-sync`, which owns their notifications; doing it here too would
 * double-send.
 *
 * DRY BY DEFAULT: `TRACKING_EMAILS_ENABLED` must be exactly "true" before a
 * single message goes out, so deploying this route mails nobody.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret =
 *  closed, never open — this route emails customers. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Empty and whitespace fall back, because `Number("")` is 0 and a cap of zero
 *  or a silent default is not what an operator who left a box blank meant. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
    console.error("[tracking-sync] email error:", error?.response?.data || error?.message);
    return 500;
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dry =
    url.searchParams.get("dry") === "1" ||
    process.env.TRACKING_EMAILS_ENABLED !== "true";
  const cap = intEnv("TRACKING_MAX_EMAILS_PER_RUN", 20);

  const parcels = await getParcelsAwaitingTracking();

  let scanned = 0;
  let notified = 0;
  let skipped = 0;
  let capped = false;

  for (const order of parcels as any[]) {
    if (notified >= cap) {
      capped = true;
      break;
    }

    // International parcels belong to amphora-sync. Notifying here as well
    // would send two emails for one milestone.
    if (isInternationalOrder(order.shippingCountry)) {
      skipped += 1;
      continue;
    }

    scanned += 1;

    try {
      const status = await obtainLastStatus(order.locator);
      const decision = decideTrackingUpdate({
        lastKey: order.lastTrackingKey ?? null,
        lastLocator: order.lastTrackingLocator ?? null,
        currentLocator: order.locator ?? null,
        phase: status.phase,
      });

      if (!decision.notify || !decision.persist) continue;

      notified += 1;
      if (dry) {
        console.log(
          `[tracking-sync] WOULD notify ${order.orderNumber}: ${decision.notify}`
        );
        continue;
      }

      // Persist BEFORE emailing. The next hourly run then finds the key
      // unchanged and does nothing, so nobody can be told twice. The cost is
      // that a failed send is not retried — hence the loud log below.
      await db
        .update(ordersTable)
        .set(decision.persist)
        .where(eq(ordersTable.id, order.id));

      const built = buildTrackingUpdateEmail(
        decision.notify,
        order.shippingName,
        readLocale(order.locale)
      );
      const status_ = await sendEmail({
        ...built,
        To: order.email,
        MessageStream: "outbound",
      });
      if (status_ !== 200) {
        console.error(
          `[tracking-sync] ${order.orderNumber}: state saved as ${decision.notify} but the email FAILED (${status_}). Customer needs a manual notice.`
        );
      }

      // A problem is the one state where a human has to act. #310664 sat
      // stranded for three weeks while a log line repeated every 15 minutes.
      if (decision.notify === "problem") {
        await alertOps(
          `[returns] TRACKING INCIDENT — order ${order.orderNumber}`,
          [
            `Correos reports an incident for ${order.orderNumber} (${order.locator}).`,
            `Status: ${status.label}`,
            `The customer has been emailed. Someone needs to find out what happened to the parcel.`,
          ].join("\n")
        );
      }
    } catch (error: any) {
      // One parcel must not stop the sweep — the rest are still owed their news.
      console.error(
        `[tracking-sync] ${order.orderNumber} failed:`,
        error?.message || error
      );
    }
  }

  return NextResponse.json({ scanned, notified, skipped, capped, dry });
}
