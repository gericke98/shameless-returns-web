// Cancellation's half of submission ownership (S2 plan L2), and the two
// cancellation primitives moved out of the "use server" db/queries.ts — where
// every export was a public endpoint — into a plain server module.
//
// The submission row is the single serialization point between settlement and
// a customer's cancellation. Cancellation takes it with ONE conditional
// UPDATE, before its first external effect (the Amphora cancel), and only when
// settlement has admitted nothing. While cancellation holds it, settlement can
// never admit it; a crash mid-cancel leaves it held, and the recovery cron
// alerts on it after an hour.
//
// NOT "use server".
import { sql } from "drizzle-orm";
import db, { readQuery } from "@/db/drizzle";
import { submissionForRow } from "@/lib/settlement/legacy";
import { SHOPIFY_API_VERSION } from "@/lib/settlement/shopify";
import type { VerifiedOrderId, VerifiedSubmission } from "@/lib/server/identity";
import {
  claimForCancellation,
  releaseCancellation,
  submissionOf,
  type CancellationClaimOutcome,
} from "@/lib/server/submissionScope";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/** One submission a cancellation reverses, with the identities it reverses by. */
export type CancellationMember = {
  /** Bound to the order being cancelled (F1): its statements carry both ids. */
  submission: VerifiedSubmission;
  /** The Shopify return this submission's lines are on — exactly one. */
  returnId: string;
  /** What to refund in Stripe, and by which identity (key `cancel:<submissionId>`). */
  payment:
    | { kind: "none" }
    /** The submission's own PaymentIntent, stored when its payment was verified. */
    | { kind: "intent"; paymentIntent: string }
    /** A legacy submission (recorded at this cancellation, D1) has no payment
     *  of its own on record: the order's single portal payment is resolved
     *  from the order — allowed only when it is the ONE submission cancelled. */
    | { kind: "order-payment" };
};

export type CancellationClaim =
  | { ok: true; members: CancellationMember[] }
  | { ok: false; reason: "already-settled" | "no-return" | "in-transit" }
  /** Membership or a payment could not be established: refused BEFORE any
   *  external effect, for a human (finding 3). */
  | { ok: false; reason: "needs-support"; detail: string };

/**
 * What the customer is told when the claim decided against them. Each is a
 * `CancelBlockedReason` the portal already explains; a submission another
 * cancellation took is no return left to cancel here.
 */
const CLAIM_REFUSAL: Record<Exclude<CancellationClaimOutcome, "claimed">, "in-transit" | "already-settled" | "no-return"> = {
  "in-transit": "in-transit",
  settled: "already-settled",
  // An operator is deciding it (a settlement hold): to the customer, it is
  // already being processed.
  held: "already-settled",
  cancelled: "no-return",
};

type CancellableRow = {
  id: number;
  confirmed?: boolean | null;
  refunded?: boolean | null;
  return_line_item_id?: string | null;
};

/** Each submission's own return(s) and payment, from the database. */
async function membersOf(submissions: readonly VerifiedSubmission[]): Promise<
  Array<{ id: string; provenance: string; chargeCents: number; paymentIntent: string | null; returnIds: string[] }>
> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT s.id, s.provenance, s.stripe_charge_cents, s.stripe_payment_intent,
             COALESCE(array_agg(DISTINCT p.return_id) FILTER (WHERE p.return_id IS NOT NULL), '{}') AS return_ids
        FROM return_submissions s
        LEFT JOIN submission_lines sl ON sl.submission_id = s.id
        LEFT JOIN productsorder p
          ON p.id = sl.productsorder_id AND p.return_line_item_id = sl.return_line_item_id
       WHERE s.id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(submissions.map((s) => s.id))}::jsonb))::uuid)
         AND s.order_id = ${submissions[0]?.orderId ?? null}
       GROUP BY s.id
    `)
  );
  return rows.map((r) => ({
    id: String(r.id),
    provenance: String(r.provenance),
    chargeCents: Number(r.stripe_charge_cents),
    paymentIntent: r.stripe_payment_intent ? String(r.stripe_payment_intent) : null,
    returnIds: (Array.isArray(r.return_ids) ? r.return_ids : []).map(String),
  }));
}

/**
 * Establish the COMPLETE set of submissions behind the return being cancelled,
 * with each one's own Shopify return and payment, then take them all. Every
 * confirmed, unsettled row must belong to a submission (a legacy one is
 * recorded first, D1); a row that cannot be mapped refuses the whole cancel
 * rather than being left out of it. All or nothing on the claim too: when
 * settlement holds any of them, the ones already taken are given back.
 * Nothing external has happened when this refuses.
 */
export async function claimOrderForCancellation(
  orderId: VerifiedOrderId,
  rows: ReadonlyArray<CancellableRow>
): Promise<CancellationClaim> {
  const current = rows.filter((r) => r.confirmed === true && r.refunded !== true);
  if (current.length === 0) return { ok: false, reason: "no-return" };
  const unmapped = current.filter((r) => !r.return_line_item_id);
  if (unmapped.length > 0) {
    return {
      ok: false,
      reason: "needs-support",
      detail: `confirmed row(s) ${unmapped.map((r) => r.id).join(", ")} carry no Shopify return line item`,
    };
  }
  const ids = new Set<string>();
  for (const row of current) {
    const found = await submissionForRow(orderId, row.id);
    if (!found.ok) {
      return { ok: false, reason: "needs-support", detail: `row ${row.id} belongs to no submission (${found.held})` };
    }
    ids.add(found.submissionId);
  }
  // Each one must be THIS order's (F1): a row's submission is only ever taken
  // through the order the customer holds a session for.
  const bound = new Map<string, VerifiedSubmission>();
  for (const id of Array.from(ids)) {
    const sub = await submissionOf(orderId, id);
    if (!sub) {
      return { ok: false, reason: "needs-support", detail: `submission ${id} does not belong to order ${orderId}` };
    }
    bound.set(id, sub);
  }

  const loaded = await membersOf(Array.from(bound.values()));
  const members: CancellationMember[] = [];
  for (const m of loaded) {
    if (m.returnIds.length !== 1) {
      return {
        ok: false,
        reason: "needs-support",
        detail: `submission ${m.id} is on ${m.returnIds.length} Shopify returns`,
      };
    }
    let payment: CancellationMember["payment"];
    if (m.provenance === "legacy") {
      if (ids.size !== 1) {
        return {
          ok: false,
          reason: "needs-support",
          detail: `legacy submission ${m.id} has no payment of its own and is cancelled with ${ids.size - 1} other(s)`,
        };
      }
      payment = { kind: "order-payment" };
    } else if (m.chargeCents > 0) {
      if (!m.paymentIntent) {
        return { ok: false, reason: "needs-support", detail: `submission ${m.id} was paid but stores no PaymentIntent` };
      }
      payment = { kind: "intent", paymentIntent: m.paymentIntent };
    } else {
      payment = { kind: "none" };
    }
    members.push({ submission: bound.get(m.id)!, returnId: m.returnIds[0], payment });
  }
  if (members.length !== ids.size) {
    return { ok: false, reason: "needs-support", detail: "a submission could not be loaded" };
  }

  const taken: VerifiedSubmission[] = [];
  for (const m of members) {
    const outcome = await claimForCancellation(m.submission);
    if (outcome !== "claimed") {
      for (const back of taken) await releaseCancellation(back);
      return { ok: false, reason: CLAIM_REFUSAL[outcome] };
    }
    taken.push(m.submission);
  }
  return { ok: true, members };
}

const RETURN_CANCEL = `
  mutation CancelReturn($id: ID!) {
    returnCancel(id: $id) {
      return { id status }
      userErrors { field message }
    }
  }`;

/**
 * Cancel a Shopify return. Reports failure rather than throwing: its only
 * caller has already cancelled the Amphora return and cannot undo that, so it
 * must carry on and alert a human instead of dying mid-chain.
 */
export async function cancelShopifyReturn(
  returnId: string
): Promise<{ success: boolean; errors?: unknown }> {
  try {
    const shop = process.env.NEXT_PUBLIC_SHOP_URL;
    const token = process.env.NEXT_PUBLIC_ACCESS_TOKEN;
    if (!shop || !token) throw new Error("Missing Shopify access token or shop URL");
    const response = await fetch(`${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: RETURN_CANCEL, variables: { id: returnId } }),
    });
    const data = await response.json();
    const userErrors = data?.data?.returnCancel?.userErrors ?? [];
    if (data.errors || userErrors.length > 0) {
      console.error("Error cancelling return:", data.errors || userErrors);
      return { success: false, errors: data.errors || userErrors };
    }
    return { success: true };
  } catch (error) {
    console.error("Fetch error cancelling return:", error);
    return { success: false, errors: error };
  }
}
