"use server";

import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { getSelfReturnsAwaitingTracking } from "@/db/queries";
import { nudgeDue, ALERT_AFTER_DAYS } from "@/lib/selfReturnNudges";
import { sendSelfReturnReminder } from "@/actions/selfReturnEmails";
import { readLocale } from "@/lib/i18n";
import { alertOps } from "./opsAlert";

/**
 * Chase self-booked returns that never came back with a tracking number.
 *
 * Runs from the existing amphora-sync cron rather than a new one: that route
 * already fires every 15 minutes and already carries CRON_SECRET, so there is
 * nothing new to misconfigure.
 */
export async function sweepSelfReturns(
  now: Date = new Date()
): Promise<{ reminded: number; alerted: number }> {
  const rows = await getSelfReturnsAwaitingTracking();
  let reminded = 0;
  let alerted = 0;

  for (const order of rows) {
    try {
      const decision = nudgeDue(order as any, now);
      if (decision.due === "none") continue;

      // Stage first, send second — the same ordering `applyReturnStatus` uses.
      // The next tick then finds the stage advanced and does nothing, so a
      // 15-minute cron cannot send 96 reminders a day. A failed send is not
      // retried, hence the loud log below.
      await db
        .update(orders)
        .set({ trackingNudgeStage: decision.nextStage })
        .where(eq(orders.id, order.id));

      if (decision.due === "reminder") {
        const status = await sendSelfReturnReminder(
          order.email,
          order.shippingName,
          readLocale(order.locale),
          order.id
        );
        if (status !== 200) {
          console.error(
            `[self-return-sweep] reminder for ${order.orderNumber} failed (${status}) and will not be retried.`
          );
        }
        reminded += 1;
        continue;
      }

      await alertOps(
        `[returns] SELF RETURN, NO TRACKING — ${order.orderNumber}`,
        [
          `A customer chose to ship their own return and never told us how.`,
          ``,
          `Order:     ${order.orderNumber} (id ${order.id})`,
          `Customer:  ${order.email}`,
          `Submitted: ${order.returnSubmittedAt?.toISOString() ?? "(unknown)"}`,
          `Waiting:   ${ALERT_AFTER_DAYS}+ days, reminder already sent`,
          ``,
          `The Shopify return is live and the Amphora ticket is still PENDING,`,
          `so no courier was ever dispatched and nothing was charged. Decide`,
          `whether to chase them, cancel the return, or leave it open.`,
        ].join("\n")
      );
      alerted += 1;
    } catch (error: any) {
      // One bad row must not stop the sweep — the others are still owed their
      // notification.
      console.error(
        `[self-return-sweep] ${order.orderNumber ?? order.id} failed:`,
        error?.message || error
      );
    }
  }

  return { reminded, alerted };
}
