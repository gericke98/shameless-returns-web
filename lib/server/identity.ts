import "server-only";
// Verified identity is a type (F1 spec §1).
//
// A `VerifiedOrderId` is an order id the server has a CREDENTIAL for: a portal
// session, a Shopify lookup match, a Stripe signature, an admin session, or a
// cron that selected the id from our own database. Every function that writes
// keyed by an order id takes one, so a raw string from the client cannot reach
// a writer: that is a type error, not a runtime refusal.
//
// The brand is nominal: a `unique symbol` property no other module can name,
// so the only way to get one is a mint below. Each mint is named by the
// credential it stands for and may be called only from the files the spec
// lists for it; tests/actionBoundary.test.ts (rule 4) fails when a mint gains
// any other caller, or when anything outside this file asserts the type.

declare const verified: unique symbol;

export type VerifiedOrderId = string & { readonly [verified]: "order" };

/** A server-minted submission id bound to the verified order it belongs to. */
export type VerifiedSubmission = {
  readonly id: string;
  readonly orderId: VerifiedOrderId;
  readonly [verified]: "submission";
};

const mint = (id: string) => String(id) as VerifiedOrderId;

/**
 * The portal session's order. Only `customerAction` (lib/server/actions.ts)
 * calls this, after reading the signed session cookie and checking it against
 * the action's `expectedOrderId`.
 */
export function fromSession(sessionOrderId: string): VerifiedOrderId {
  return mint(sessionOrderId);
}

/**
 * The order whose number and contact email were just matched against Shopify
 * by the lookup (rate limit passed). Only lib/server/handlers/lookup.ts calls
 * this, after validation and before it saves the order or issues the session.
 */
export function verifiedByLookup(order: { id: string | number }): VerifiedOrderId {
  return mint(String(order.id));
}

/**
 * The order named in a Checkout session's metadata, once Stripe's signature
 * over that event has been verified (`constructEvent`). Only the Stripe webhook
 * calls this.
 */
export function verifiedByStripeSignature(metadata: { id: string }): VerifiedOrderId {
  return mint(metadata.id);
}

/** An order an admin acted on. Only admin handlers call this, with their ctx. */
export function adminTarget(id: string, ctx: { admin: string }): VerifiedOrderId {
  void ctx;
  return mint(id);
}

/**
 * An order a scheduled job (or an operator's system tool) selected from our
 * own database. Only cron routes and system handlers call this.
 */
export function systemTarget(id: string, job: string): VerifiedOrderId {
  void job;
  return mint(id);
}

/**
 * Bind a submission id to its order. Only lib/server/submissionScope.ts calls
 * this, and only for a pair the database just proved: the row it inserted for
 * that order, or a `SELECT … WHERE id = $sid AND order_id = $orderId` that
 * matched. A submission is never verified from an id alone.
 */
export function boundSubmission(orderId: VerifiedOrderId, submissionId: string): VerifiedSubmission {
  return { id: String(submissionId), orderId } as VerifiedSubmission;
}
