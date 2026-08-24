// Pure — no db, no network, and no clock of its own. `now` is a parameter so
// the whole 3/10-day matrix is testable without waiting ten days.

export type NudgeDecision =
  | { due: "none" }
  | { due: "reminder"; nextStage: 1 }
  | { due: "alert"; nextStage: 2 };

export type NudgeableOrder = {
  returnMethod?: string | null;
  returnSubmittedAt?: Date | null;
  trackingSubmittedAt?: Date | null;
  trackingNudgeStage?: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_AFTER_DAYS = 3;
export const ALERT_AFTER_DAYS = 10;

const NONE: NudgeDecision = { due: "none" };

/**
 * Which nudge, if any, this return has earned.
 *
 * A self-booked return that never comes back leaves a live Shopify return and a
 * PENDING warehouse ticket. Order #311174 is the standing lesson: a state
 * nobody is told about persists until the customer complains.
 */
export function nudgeDue(order: NudgeableOrder, now: Date): NudgeDecision {
  if (order.returnMethod !== "SELF") return NONE;
  if (order.trackingSubmittedAt) return NONE;

  // Legacy rows carry no stamp. Reading null as the epoch would make every one
  // of them infinitely overdue and alert on the entire order book.
  const submitted = order.returnSubmittedAt;
  if (!submitted) return NONE;

  const stage = order.trackingNudgeStage ?? 0;
  if (stage >= 2) return NONE;

  const ageDays = (now.getTime() - submitted.getTime()) / DAY_MS;

  if (ageDays >= ALERT_AFTER_DAYS) return { due: "alert", nextStage: 2 };
  if (ageDays >= REMINDER_AFTER_DAYS && stage < 1) {
    return { due: "reminder", nextStage: 1 };
  }
  return NONE;
}
