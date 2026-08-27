// Applying an Amphora return-status change: persist it, and tell the customer.
//
// Extracted from the webhook route so that the PUSH path (Amphora calls us) and
// the PULL path (we poll them) cannot drift. Amphora has not registered our
// webhook, so today only the pull path actually runs — but a return whose
// status we learn by polling must produce byte-identical state and emails to
// one we learn by webhook, or customers get different treatment depending on
// which channel happened to notice first.
//
// Safe to run from both at once. `decideWebhookActions` no-ops when the status
// is unchanged, and only emits `collectionScheduled` when we hold no locator
// yet, so whichever path arrives second does nothing.
import axios from "axios";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import {
  buildCollectionScheduledEmail,
  buildReturnReceivedEmail,
  buildTrackingUpdateEmail,
} from "@/lib/emails";
import { exchangeFromProducts } from "@/lib/exchange";
import { readLocale } from "@/lib/i18n";
import {
  decideWebhookActions,
  type AmphoraWebhookReturn,
} from "@/lib/amphoraWebhook";
import { alertOps } from "@/actions/opsAlert";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** The order fields this module reads. Structural so both callers can pass
 *  their own row without reshaping it. */
export type SyncableOrder = {
  id: string;
  orderNumber: string;
  email: string;
  shippingName: string;
  locale?: string | null;
  returnStatus?: string | null;
  locator?: string | null;
  /** The milestone rank already communicated for this parcel, and which parcel
   *  it refers to. Read by `decideWebhookActions` so a status that oscillates
   *  (TRAVELLING -> EXCEPTION_HOLD -> TRAVELLING is an ordinary customs hold)
   *  cannot email the same milestone again on every 15-minute poll. */
  lastTrackingKey?: string | null;
  lastTrackingLocator?: string | null;
  products?: unknown;
};

export type SyncOutcome = {
  changed: boolean;
  status?: string;
  emailsSent: string[];
  emailsFailed: string[];
};

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
      "Amphora status email error:",
      error?.response?.data || error?.message || error
    );
    return 500;
  }
}

/**
 * Persist a status change and send whatever it entitles the customer to.
 *
 * Persist happens BEFORE emailing on purpose: a redelivery (or the next poll)
 * then finds the status unchanged and does nothing, so nobody can be emailed
 * twice. The cost is that a failed email is not retried — hence the loud log.
 */
export async function applyReturnStatus(
  order: SyncableOrder,
  payload: AmphoraWebhookReturn
): Promise<SyncOutcome> {
  const actions = decideWebhookActions(order, payload);
  if (actions.noop || !actions.persist) {
    return { changed: false, emailsSent: [], emailsFailed: [] };
  }

  await db.update(orders).set(actions.persist).where(eq(orders.id, order.id));

  const locale = readLocale(order.locale);
  const exchange = exchangeFromProducts((order as any).products);
  const emailsSent: string[] = [];
  const emailsFailed: string[] = [];

  for (const email of actions.emails) {
    const built =
      email === "collectionScheduled"
        ? buildCollectionScheduledEmail(
            order.shippingName,
            locale,
            { number: payload.carrier_number, url: payload.carrier_url },
            exchange
          )
        : email === "trackingInTransit"
          ? buildTrackingUpdateEmail("in_transit", order.shippingName, locale)
          : email === "trackingProblem"
            ? buildTrackingUpdateEmail("problem", order.shippingName, locale)
            : buildReturnReceivedEmail(order.shippingName, locale, exchange);

    const status = await sendEmail({
      ...built,
      To: order.email,
      MessageStream: "outbound",
    });
    if (status === 200) {
      emailsSent.push(email);
    } else {
      emailsFailed.push(email);
      console.error(
        `[amphora-sync] order ${order.id}: status saved as ${actions.persist.returnStatus} but the "${email}" email FAILED (${status}). Customer needs a manual notice.`
      );
    }
  }

  // A problem is the one state where a human has to act, and the customer has
  // just been told there is one — so somebody here has to know too.
  //
  // This used to be a `console.error` covering only two of the four exception
  // statuses. Vercel keeps runtime logs for about an hour, so that was not a
  // record anyone would find tomorrow: #310664 sat stranded for three weeks
  // while exactly that line repeated every 15 minutes, unread.
  //
  // Keyed off the EMAIL rather than the status, so ops is alerted once per
  // incident — on the same event that told the customer, and never again while
  // the parcel flaps in and out of the hold.
  if (actions.emails.includes("trackingProblem")) {
    await alertOps(
      `[returns] TRACKING INCIDENT — order ${order.orderNumber}`,
      [
        `Amphora reports ${payload.internal_status} for ${order.orderNumber}.`,
        `Parcel: ${payload.carrier_number ?? order.locator ?? "(none on file)"}`,
        `Carrier: ${payload.carrier ?? "(unknown)"}`,
        `Customer: ${order.email}`,
        `The customer has been emailed. Someone needs to find out what happened to the parcel.`,
      ].join("\n")
    );
  }

  return {
    changed: true,
    status: actions.persist.returnStatus,
    emailsSent,
    emailsFailed,
  };
}
