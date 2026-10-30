// The durable ops-alert outbox. NOT a server action, for the same reason as
// actions/opsAlert.ts: an exported action taking `subject`/`body` is an
// unauthenticated endpoint that emails ops.
//
// Producers enqueue with an explicit dedupe key; a cron dispatches. A row is
// delivered only when Postmark accepts it, so an outage or a crash delays an
// alert and never loses it. A producer that re-detects the same condition on
// every run re-enqueues the same key, which is a no-op.
import {
  claimPendingOpsAlerts,
  insertOpsAlert,
  markOpsAlertAccepted,
  markOpsAlertFailed,
} from "@/db/opsAlerts";
import { sendOpsAlert } from "./opsAlert";

/** Rows sent per dispatch. Bounds a Postmark outage to ~5 × 5 s of a cron's
 *  budget; the rest wait for the next run. */
export const OPS_ALERT_DISPATCH_LIMIT = 5;

/** Record an alert for delivery. True if it is new, false if the key exists. */
export async function enqueueOpsAlert(alert: {
  dedupeKey: string;
  subject: string;
  body: string;
}): Promise<boolean> {
  const inserted = await insertOpsAlert(alert);
  if (inserted) console.error(`[ops] queued ${alert.dedupeKey}: ${alert.subject}`);
  return inserted;
}

/**
 * Enqueue several, never throwing: one failed insert is logged and the rest go
 * ahead. For producers that re-detect their conditions on every run, so a lost
 * insert is retried by the next run.
 */
export async function enqueueOpsAlerts(
  alerts: Array<{ dedupeKey: string; subject: string; body: string }>
): Promise<void> {
  for (const alert of alerts) {
    try {
      await enqueueOpsAlert(alert);
    } catch (error: any) {
      console.error(`[ops-outbox] could not queue ${alert.dedupeKey}:`, error?.message || error);
    }
  }
}

/** Try to deliver what is pending. Failures stay pending for the next run. */
export async function dispatchOpsAlerts(
  limit: number = OPS_ALERT_DISPATCH_LIMIT
): Promise<{ sent: number; failed: number }> {
  const claimed = await claimPendingOpsAlerts(limit);
  let sent = 0;
  let failed = 0;

  for (const alert of claimed) {
    const result = await sendOpsAlert(alert.subject, alert.body);
    if (result.ok) {
      await markOpsAlertAccepted(alert.id);
      sent += 1;
    } else {
      console.error(`[ops-outbox] ${alert.dedupeKey} not accepted: ${result.error}`);
      await markOpsAlertFailed(alert.id, result.error);
      failed += 1;
    }
  }

  return { sent, failed };
}
