// Shapes shared by the settlement ledger (drizzle/0007, S2 plan L1–L8).
// Pure types and constants: no db, no network.

export type OpKind =
  | "process_refund"
  | "root_refund"
  | "gift_card"
  | "exchange_order"
  | "release_hold"
  | "process_goods";

export type OpState = "pending" | "claimed" | "dispatched" | "done" | "rejected" | "unresolved";

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
  attempt: number;
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
        /** process_refund only: the money that must appear on the return. */
        refund?: { parentTransactionId: string; money: FrozenMoney };
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
