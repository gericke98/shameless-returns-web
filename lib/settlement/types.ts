// Shapes shared by the settlement ledger (drizzle/0007, S2 plan L1–L8).
// Pure types and constants: no db, no network.

export type OpKind =
  | "process_refund"
  | "root_refund"
  | "gift_card"
  | "exchange_order"
  | "release_hold"
  | "process_goods";

/** `void` (drizzle/0012): an operation of a voided reconciliation record — no fence matches it. */
export type OpState = "pending" | "claimed" | "dispatched" | "done" | "rejected" | "unresolved" | "void";

/** One external effect, as stored. */
export type Operation = {
  id: string;
  submissionId: string;
  kind: OpKind;
  scopeKey: string;
  members: number[];
  after: string | null;
  request: OpRequest;
  amountCents: number;
  currency: string;
  state: OpState;
  /** The financial attempt: the refundCreate idempotency key is `<id>:<attempt>`.
   *  Moves only when a new send is proven safe (pending or rejected). */
  attempt: number;
  /** The worker fence (0008): moves on every claim and takeover. */
  leaseGen: number;
  owner: string | null;
  leaseUntil: Date | null;
  dispatchedAt: Date | null;
  effectRef: string | null;
  evidence: unknown;
  error: string | null;
};

/** The presentment money a refund transaction must carry, frozen at admission. */
export type FrozenMoney = { amount: string; currencyCode: string };

/**
 * What `send` posts (`variables`, verbatim) and what the evidence predicate
 * checks against (`check`). Both are frozen at admission; nothing is
 * recomputed at send time.
 */
export type OpRequest =
  | {
      kind: "process_goods" | "process_refund";
      variables: { input: Record<string, unknown> };
      check: {
        returnId: string;
        returnLineItemId: string;
        reverseFulfillmentLineItemId: string;
        quantity: number;
        /** process_refund only: the money that must appear on the return, and
         *  the order line item whose refund it is — the refund's identity
         *  (finding 6): the one refund on this return that refunds this line
         *  item is this op's, whatever its amount. */
        refund?: { parentTransactionId: string; money: FrozenMoney; lineItemGid: string };
      };
    }
  | {
      kind: "root_refund";
      variables: { input: Record<string, unknown> };
      check: {
        /** The order the refund is created on (the root of a replacement). */
        orderGid: string;
        marker: string;
        parentTransactionId: string;
        money: FrozenMoney;
      };
    }
  | {
      kind: "gift_card";
      variables: { input: Record<string, unknown> };
      check: { code: string; customerGid: string; money: FrozenMoney; noteMarker: string };
    }
  | {
      kind: "exchange_order";
      variables: { order: Record<string, unknown>; options: Record<string, unknown> };
      check: {
        sourceIdentifier: string;
        customerGid: string | null;
        lines: Array<{
          sourceProductsorderId: number;
          variantGid: string;
          quantity: number;
          stripeFundedCents: number;
        }>;
      };
    }
  | {
      kind: "release_hold";
      variables: { input: { id: string } };
      check: { draftOrderId: string; orderId: string };
    };

/**
 * S3: an operation of a `reconciled` submission records a payment made before
 * the ledger (scripts/reconcile-legacy.ts). It has no variables: it is never
 * sent (lib/settlement/ledger.ts skips it in every claim). `check` is the
 * line's identity, for the operator who resolves an unresolved one. Not a
 * member of `OpRequest`, which is what the runner sends: nothing that sends
 * may ever be handed one. Read it through `reconciliationRequestOf`.
 */
export type ReconciliationRequest = {
  kind: "reconciliation";
  lane: "refund" | "root_refund" | "credit" | "exchange" | "native_exchange";
  check: {
    orderNumber: string;
    returnId: string;
    returnLineItemId: string;
    lineItemId: string;
    customerGid: string | null;
    newVariantGid: string | null;
    quantity: number;
    giftCardId: string | null;
  };
  classified: { cls: string; reason: string };
};

/** The line-item property that names which returned garment a replacement line replaces. */
export const SOURCE_LINE_PROPERTY = "_settlement_source_line";

/** How long a claim is exclusive, and how long a dispatch may go unanswered
 *  before recovery looks at it. */
export const LEASE_MINUTES = 10;

/** root_refund idempotency keys are kept 24 h by Shopify; we only replay within 23. */
export const ROOT_REFUND_REPLAY_HOURS = 23;

/** One status per line, reported by settleSubmission (L8). */
export type LineStatus =
  | "paid"
  | "goods-pending"
  | "in-flight"
  | "unresolved"
  | `held:${string}`;

/** The reconciliation request an operation carries, or null for every op the runner may send. */
export function reconciliationRequestOf(request: unknown): ReconciliationRequest | null {
  return (request as { kind?: unknown } | null)?.kind === "reconciliation"
    ? (request as ReconciliationRequest)
    : null;
}
