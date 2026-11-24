// The submit refusal "money comes back and no payout was chosen". Its own module
// (no db, no React) so both the server that throws it and the action that turns
// it into a typed result can import it without dragging either's dependencies.

/**
 * An expected refusal, not a crash: returnFunction turns it into
 * `{ ok: false, reason: "payout-required" }`, which sends the customer back to
 * the payout step. The message is unchanged so existing alerts and log
 * searches still match.
 */
export class PayoutRequiredError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId}: money is owed back but no payout was chosen`);
    this.name = "PayoutRequiredError";
  }
}

/** What returnFunction hands back instead of the crash screen. */
export type SubmitRefusal = { ok: false; reason: "payout-required" };
