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

/** An admin session acting (F1 spec §11): carries who, for writes keyed by no single order. */
export type AdminTarget = { readonly admin: string; readonly [verified]: "admin" };

/** A scheduled job acting on rows it selected itself (F1 spec §11), minted at the cron entry. */
export type SystemTarget = { readonly job: string; readonly [verified]: "system" };

/** The capabilities that may obtain a write handle (db/drizzle.ts `writeDb`). */
export type WriteCapability = VerifiedOrderId | VerifiedSubmission | AdminTarget | SystemTarget;

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

/**
 * An admin acting. Only `adminAction` (lib/server/actions.ts) calls this,
 * after reading the admin next-auth session: handlers never mint, they
 * receive the result in their context (F1 spec §11 threat model, Codex #4).
 * With the session: the session itself (`AdminTarget`), for an admin write
 * keyed by no single order. With an order id: that order (a
 * `VerifiedOrderId`), and only for the holder of an `AdminTarget` (G3).
 */
export function adminTarget(session: { admin: string }): AdminTarget;
export function adminTarget(id: string, admin: AdminTarget): VerifiedOrderId;
export function adminTarget(a: string | { admin: string }, admin?: AdminTarget): VerifiedOrderId | AdminTarget {
  if (typeof a === "string") {
    void admin;
    return mint(a);
  }
  return { admin: a.admin } as AdminTarget;
}

/**
 * A scheduled job, or an operator's tool. Only cron routes (after
 * `verifyCronRequest`) and scripts/ call this. With an id: an order the job selected from
 * our own database (a `VerifiedOrderId`). Without one: the job itself
 * (`SystemTarget`), minted at its entry and passed down to what it writes
 * (F1 spec §11, G2/G3).
 */
export function systemTarget(job: string): SystemTarget;
export function systemTarget(id: string, job: string): VerifiedOrderId;
export function systemTarget(a: string, job?: string): VerifiedOrderId | SystemTarget {
  if (job === undefined) return { job: a } as SystemTarget;
  return mint(a);
}

/**
 * The order an Amphora webhook names, once its shared `X-Secret` matched.
 * Only app/api/webhooks/amphora/route.ts calls this, after that check (F1
 * spec §11, G1). Which order the payload names is still F4's to make an
 * explicit identity.
 */
export function verifiedByAmphoraSecret(order: { id: string | number }): VerifiedOrderId {
  return mint(String(order.id));
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
