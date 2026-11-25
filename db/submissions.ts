// The submission agreement's shared types (drizzle/0006_return_submissions.sql)
// and the one cron transition that is not keyed by a submission.
//
// Everything keyed by a submission lives in lib/server/submissionScope.ts and
// takes a `VerifiedSubmission` (F1): a submission id is never enough on its own.
//
// NOT a "use server" module, for the same reason as db/opsAlerts.ts: nothing
// here may be callable from a browser.
import { sql } from "drizzle-orm";
import db from "./drizzle";

export type SubmissionLineInput = {
  productsorderId: number;
  shopifyLineItemId: string;
  /** Resolved before checkout: the garment the Shopify return will name. */
  fulfillmentLineItemId: string;
  newVariantId: string | null;
  reason: string | null;
  notes: string | null;
};

export type PaymentEvidence = {
  sessionId: string;
  amountTotal: number | null;
  currency: string | null;
  paymentStatus: string | null;
  paymentIntent: string | null;
};

export type PaidOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "superseded"; state: string }
  | { kind: "mismatch"; detail: string }
  | { kind: "unknown-submission" };

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/** Expire submissions whose Stripe session can no longer be paid (24 h, plus margin). */
export async function abandonExpiredSubmissions(): Promise<string[]> {
  const result = await db.execute(sql`
    UPDATE return_submissions SET state = 'abandoned'
     WHERE state = 'awaiting_payment' AND created_at < now() - interval '25 hours'
    RETURNING id
  `);
  return rowsOf(result).map((r) => String(r.id));
}
