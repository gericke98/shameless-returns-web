// Releasing an exchange's stock hold OUTSIDE the ledger (finding 9).
//
// The ledger releases a hold with its own `release_hold` operation. Two other
// moments must release one too: a customer's cancellation (the return is
// gone) and a confirmation that failed and was reverted (no return was ever
// created). Both go through `releaseHoldDraft` in lib/settlement/effects.ts —
// the ONE draftOrderDelete document, on SHOPIFY_API_VERSION — and only with an
// authority minted here, after the database proves the caller owns the hold:
//
//   cancellation — every submission named is accepted, held by cancellation
//                  and on this order, and no OTHER accepted submission on the
//                  order still has an unsettled exchange line (that hold
//                  would be its);
//   revert       — the order carries no live return (no confirmed, unrefunded
//                  row with a Shopify return id) and settlement has no
//                  unfinished exchange or hold release on it.
//
// Then the draft is judged gone (deleted, or already absent) and the order's
// pointer to it is cleared — the pointer only when it still names THIS draft.
//
// Never throws: both callers have already done something irreversible.
// NOT "use server".
import { sql } from "drizzle-orm";
import db from "@/db/drizzle";
import { releaseHoldDraft, type HoldReleaseAuthority } from "./effects";
import { graphQLErrors } from "./shopify";
import { DRAFT_ORDER_QUERY, read } from "./reads";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export type HoldRelease =
  /** There is no hold now: released, already gone, or never placed. */
  | { released: true }
  | { released: false; reason: string };

async function heldDraftOf(orderId: string): Promise<string | null> {
  const [row] = rowsOf(
    await db.execute(sql`SELECT exchange_reservation_id FROM orders WHERE id = ${orderId}`)
  );
  return row?.exchange_reservation_id ? String(row.exchange_reservation_id) : null;
}

async function cancellationOwnsHold(orderId: string, submissionIds: readonly string[]): Promise<string | null> {
  const ids = JSON.stringify(submissionIds);
  const [row] = rowsOf(
    await db.execute(sql`
      SELECT
        (SELECT count(*) FROM return_submissions s
          WHERE s.id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid)
            AND s.order_id = ${orderId} AND s.state = 'accepted' AND s.holder = 'cancellation')::int AS held,
        (SELECT count(*) FROM return_submissions s
           JOIN submission_lines sl ON sl.submission_id = s.id
          WHERE s.order_id = ${orderId} AND s.state = 'accepted'
            AND s.id NOT IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid)
            AND sl.action = 'CAMBIO' AND sl.settled_at IS NULL)::int AS others
    `)
  );
  if (Number(row?.held) !== submissionIds.length) return "a named submission is not held by this cancellation";
  if (Number(row?.others) > 0) return "another accepted submission on the order still owns an exchange";
  return null;
}

async function revertOwnsHold(orderId: string): Promise<string | null> {
  const [row] = rowsOf(
    await db.execute(sql`
      SELECT
        (SELECT count(*) FROM productsorder p
          WHERE p.order_id = ${orderId} AND p.confirmed = true
            AND p.return_id IS NOT NULL AND p.refunded IS NOT TRUE)::int AS live,
        (SELECT count(*) FROM settlement_operations o
           JOIN return_submissions s ON s.id = o.submission_id
          WHERE s.order_id = ${orderId}
            AND o.kind IN ('exchange_order', 'release_hold') AND o.state <> 'done')::int AS settling
    `)
  );
  if (Number(row?.live) > 0) return "the order still carries a live Shopify return";
  if (Number(row?.settling) > 0) return "settlement is still executing an exchange on this order";
  return null;
}

async function release(orderId: string, by: HoldReleaseAuthority["by"], refusal: string | null): Promise<HoldRelease> {
  try {
    const draftOrderId = await heldDraftOf(orderId);
    if (!draftOrderId) return { released: true };
    if (refusal) return { released: false, reason: refusal };
    const authority = { orderId, draftOrderId, by } as HoldReleaseAuthority;

    const answer = await releaseHoldDraft(authority);
    const deleted =
      answer.kind === "answer" &&
      !graphQLErrors(answer.body) &&
      answer.body?.data?.draftOrderDelete?.deletedId === draftOrderId;
    if (!deleted) {
      // Refused, or no answer: Shopify decides whether the draft is gone.
      const now = await read(DRAFT_ORDER_QUERY, { id: draftOrderId }, (d) => d?.draftOrder ?? null);
      if (!now.ok) return { released: false, reason: `draft ${draftOrderId} unreadable: ${now.error}` };
      if (now.value) return { released: false, reason: `draft ${draftOrderId} still exists` };
    }
    await db.execute(sql`
      UPDATE orders SET exchange_reservation_id = NULL
       WHERE id = ${orderId} AND exchange_reservation_id = ${draftOrderId}
    `);
    return { released: true };
  } catch (error: any) {
    return { released: false, reason: String(error?.message ?? error) };
  }
}

/** A cancellation releases the hold of the submissions it holds. */
export async function releaseHoldForCancellation(
  orderId: string,
  submissionIds: readonly string[]
): Promise<HoldRelease> {
  let refusal: string | null;
  try {
    refusal = await cancellationOwnsHold(orderId, submissionIds);
  } catch (error: any) {
    return { released: false, reason: String(error?.message ?? error) };
  }
  return release(orderId, "cancellation", refusal);
}

/** A failed confirmation, reverted, releases the hold it placed. */
export async function releaseHoldForRevert(orderId: string): Promise<HoldRelease> {
  let refusal: string | null;
  try {
    refusal = await revertOwnsHold(orderId);
  } catch (error: any) {
    return { released: false, reason: String(error?.message ?? error) };
  }
  return release(orderId, "revert", refusal);
}
