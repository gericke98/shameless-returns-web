// The database half of the settlement ledger (drizzle/0007, S2 plan L2–L5).
//
// Every transition is ONE conditional statement — `UPDATE … WHERE state = …
// RETURNING` — and the row's state, never a prior read, decides who wins.
// Finalization is one non-interactive transaction (`transact`) serialised on
// the submission row lock. No interactive transaction is ever opened.
//
// NOT "use server": nothing here may be callable from a browser.
import { sql, type SQL } from "drizzle-orm";
import db, { transact } from "@/db/drizzle";
import {
  LEASE_MINUTES,
  ROOT_REFUND_REPLAY_HOURS,
  type Operation,
  type OpKind,
  type OpRequest,
} from "./types";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

declare const dispatched: unique symbol;
/**
 * The row returned by the dispatch UPDATE. Only `dispatch` below produces one,
 * and `send` (lib/settlement/effects.ts) refuses to post without it.
 */
export type DispatchToken = Operation & { readonly [dispatched]: true };

function toOperation(row: any): Operation {
  return {
    id: String(row.id),
    submissionId: String(row.submission_id),
    kind: row.kind as OpKind,
    scopeKey: String(row.scope_key),
    members: (row.members ?? []).map(Number),
    after: row.after ? String(row.after) : null,
    request: (typeof row.request === "string" ? JSON.parse(row.request) : row.request) as OpRequest,
    amountCents: Number(row.amount_cents ?? 0),
    currency: String(row.currency ?? "EUR"),
    state: row.state,
    attempt: Number(row.attempt ?? 0),
    leaseGen: Number(row.lease_gen ?? 0),
    owner: row.owner ? String(row.owner) : null,
    leaseUntil: row.lease_until ? new Date(row.lease_until) : null,
    dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at) : null,
    effectRef: row.effect_ref ?? null,
    evidence: row.evidence ?? null,
    error: row.error ?? null,
  };
}

const lease = sql.raw(`interval '${LEASE_MINUTES} minutes'`);

/**
 * S3 (drizzle/0009): an operation of a `reconciled` submission RECORDS a
 * payment made before the ledger existed (scripts/reconcile-legacy.ts). It is
 * never claimed and never recovered, so no state an operator gives it — not
 * even `rejected`, "no payment happened" — can turn the record into a send.
 * `o` is the settlement_operations alias of every statement that uses it.
 */
const notReconciliation = sql`NOT EXISTS (SELECT 1 FROM return_submissions rs
                                           WHERE rs.id = o.submission_id AND rs.state = 'reconciled')`;
const replayWindow = sql.raw(`interval '${ROOT_REFUND_REPLAY_HOURS} hours'`);

// ── reads ──────────────────────────────────────────────────────────────────

export async function getOperation(id: string): Promise<Operation | null> {
  const rows = rowsOf(await db.execute(sql`SELECT * FROM settlement_operations WHERE id = ${id}`));
  return rows[0] ? toOperation(rows[0]) : null;
}

export async function operationsOf(submissionId: string): Promise<Operation[]> {
  const rows = rowsOf(
    await db.execute(
      sql`SELECT * FROM settlement_operations WHERE submission_id = ${submissionId} ORDER BY created_at, scope_key`
    )
  );
  return rows.map(toOperation);
}

export type SubmissionForAdmission = {
  id: string;
  orderId: string;
  state: string;
  tender: "refund" | "credit";
  currency: string;
  residualCents: number;
  holder: string | null;
  admissionSeq: number;
  provenance: string;
};

export type SubmissionLineRow = {
  productsorderId: number;
  /** The order line item this line returns, as S1 froze it (bare id or gid). */
  shopifyLineItemId: string;
  quantity: number;
  action: string;
  newVariantId: string | null;
  payCents: number;
  stripeFundedCents: number;
  returnedCents: number;
  fulfillmentLineItemId: string | null;
  returnLineItemId: string | null;
  reverseFulfillmentLineItemId: string | null;
  settledAt: Date | null;
};

export async function loadSubmission(
  submissionId: string
): Promise<{ submission: SubmissionForAdmission; lines: SubmissionLineRow[] } | null> {
  const [s] = rowsOf(
    await db.execute(sql`SELECT * FROM return_submissions WHERE id = ${submissionId}`)
  );
  if (!s) return null;
  const lines = rowsOf(
    await db.execute(
      sql`SELECT * FROM submission_lines WHERE submission_id = ${submissionId} ORDER BY productsorder_id`
    )
  );
  return {
    submission: {
      id: String(s.id),
      orderId: String(s.order_id),
      state: String(s.state),
      tender: s.tender,
      currency: String(s.currency),
      residualCents: Number(s.residual_cents),
      holder: s.holder ?? null,
      admissionSeq: Number(s.admission_seq),
      provenance: String(s.provenance),
    },
    lines: lines.map((l) => ({
      productsorderId: Number(l.productsorder_id),
      shopifyLineItemId: String(l.shopify_line_item_id),
      quantity: Number(l.quantity),
      action: String(l.action),
      newVariantId: l.new_variant_id ?? null,
      payCents: Number(l.pay_cents),
      stripeFundedCents: Number(l.stripe_funded_cents),
      returnedCents: Number(l.returned_cents),
      fulfillmentLineItemId: l.fulfillment_line_item_id ?? null,
      returnLineItemId: l.return_line_item_id ?? null,
      reverseFulfillmentLineItemId: l.reverse_fulfillment_line_item_id ?? null,
      settledAt: l.settled_at ? new Date(l.settled_at) : null,
    })),
  };
}

/**
 * The accepted submission a productsorder row currently belongs to: the one
 * whose line carries the SAME Shopify return line item the row carries. That
 * id is Shopify's, stable and explicit; a row reset by a cancellation carries
 * none and so belongs to nothing.
 */
export async function submissionOfRow(productsorderId: number): Promise<string | null> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT sl.submission_id
        FROM submission_lines sl
        JOIN return_submissions s ON s.id = sl.submission_id
        JOIN productsorder p ON p.id = sl.productsorder_id
       WHERE sl.productsorder_id = ${productsorderId}
         AND s.state = 'accepted'
         AND sl.return_line_item_id IS NOT NULL
         AND sl.return_line_item_id = p.return_line_item_id
    `)
  );
  if (rows.length > 1) {
    throw new Error(`row ${productsorderId} belongs to ${rows.length} accepted submissions`);
  }
  return rows[0] ? String(rows[0].submission_id) : null;
}

/** `submissionOfRow` for many rows at once (the dashboard's grouping). */
export async function submissionsOfRows(productsorderIds: readonly number[]): Promise<Map<number, string>> {
  if (productsorderIds.length === 0) return new Map();
  const rows = rowsOf(
    await db.execute(sql`
      SELECT sl.productsorder_id, sl.submission_id
        FROM submission_lines sl
        JOIN return_submissions s ON s.id = sl.submission_id
        JOIN productsorder p ON p.id = sl.productsorder_id
       WHERE sl.productsorder_id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(productsorderIds)}::jsonb))::int)
         AND s.state = 'accepted'
         AND sl.return_line_item_id IS NOT NULL
         AND sl.return_line_item_id = p.return_line_item_id
    `)
  );
  return new Map(rows.map((r) => [Number(r.productsorder_id), String(r.submission_id)]));
}

/**
 * S3: the reconciliation records (drizzle/0009) that still stand on these
 * rows — an operation of a `reconciled` submission that is done (the line was
 * paid before the ledger) or unresolved (a human has not decided). Nothing
 * may record or admit a new payment for such a row; one an operator marked
 * `rejected` ("no payment happened") no longer stands.
 */
export async function standingReconciliations(
  productsorderIds: readonly number[]
): Promise<Map<number, { opId: string; state: string }>> {
  if (productsorderIds.length === 0) return new Map();
  const rows = rowsOf(
    await db.execute(sql`
      SELECT m.po, o.id, o.state
        FROM settlement_operations o
        JOIN return_submissions s ON s.id = o.submission_id AND s.state = 'reconciled'
        CROSS JOIN LATERAL unnest(o.members) AS m(po)
       WHERE o.state <> 'rejected'
         AND m.po IN (SELECT (jsonb_array_elements_text(${JSON.stringify(productsorderIds)}::jsonb))::int)
    `)
  );
  return new Map(rows.map((r) => [Number(r.po), { opId: String(r.id), state: String(r.state) }]));
}

// ── L3: admission, one statement ───────────────────────────────────────────

export type NewOperation = {
  id: string;
  kind: OpKind;
  scope_key: string;
  members: number[];
  after: string | null;
  request: OpRequest;
  amount_cents: number;
  currency: string;
};

/**
 * Take the submission for settlement and write every operation in ONE
 * statement. Zero rows from `s` means a concurrent admission bumped the
 * sequence, or a cancellation holds the submission: nothing is written.
 */
export async function insertAdmission(input: {
  submissionId: string;
  seenSeq: number;
  ops: NewOperation[];
  reverseFulfillment: Array<{ productsorder_id: number; rfo: string }>;
}): Promise<{ admitted: boolean; inserted: number }> {
  const result = await db.execute(sql`
    WITH s AS (
      UPDATE return_submissions
         SET admission_seq = admission_seq + 1,
             holder_since = CASE WHEN holder = 'settlement' THEN holder_since ELSE now() END,
             holder = 'settlement'
       WHERE id = ${input.submissionId}
         AND admission_seq = ${input.seenSeq}
         AND state = 'accepted'
         AND holder IS DISTINCT FROM 'cancellation'
      RETURNING id
    ),
    rfo AS (
      UPDATE submission_lines sl
         SET reverse_fulfillment_line_item_id = r.rfo
        FROM s, jsonb_to_recordset(${JSON.stringify(input.reverseFulfillment)}::jsonb)
             AS r(productsorder_id integer, rfo text)
       WHERE sl.submission_id = s.id
         AND sl.productsorder_id = r.productsorder_id
         AND sl.reverse_fulfillment_line_item_id IS NULL
      RETURNING 1
    ),
    ins AS (
      INSERT INTO settlement_operations
        (id, submission_id, kind, scope_key, members, after, request, amount_cents, currency)
      SELECT o.id, s.id, o.kind, o.scope_key, o.members, o.after, o.request, o.amount_cents, o.currency
        FROM s, jsonb_to_recordset(${JSON.stringify(input.ops)}::jsonb) AS o(
          id uuid, kind text, scope_key text, members integer[], after uuid,
          request jsonb, amount_cents integer, currency text)
      ON CONFLICT (scope_key) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM s)::int AS admitted,
           (SELECT count(*) FROM ins)::int AS inserted,
           (SELECT count(*) FROM rfo)::int AS frozen
  `);
  const row = rowsOf(result)[0] ?? {};
  return { admitted: Number(row.admitted) === 1, inserted: Number(row.inserted ?? 0) };
}

// ── L4: claim → dispatch → record ──────────────────────────────────────────

/**
 * Claim an op that may be SENT AFRESH: a pending op (never sent) or a
 * rejected one (Shopify said no, so nothing happened) — those two start a new
 * financial attempt and forget any earlier dispatch. A claim whose lease ran
 * out is reclaimed only if it never dispatched (`dispatched_at IS NULL`), and
 * keeps its attempt. Anything that ever dispatched is NOT claimable here: it
 * goes back through evidence and replay via `takeOver` (finding 1).
 * Every claim moves `lease_gen`, the worker fence.
 */
export async function claim(opId: string, me: string): Promise<Operation | null> {
  const rows = rowsOf(
    await db.execute(sql`
      UPDATE settlement_operations o
         SET state = 'claimed', owner = ${me}, lease_gen = o.lease_gen + 1,
             attempt = CASE WHEN o.state IN ('pending', 'rejected') THEN o.attempt + 1 ELSE o.attempt END,
             dispatched_at = CASE WHEN o.state IN ('pending', 'rejected') THEN NULL ELSE o.dispatched_at END,
             lease_until = now() + ${lease}, updated_at = now()
       WHERE o.id = ${opId}
         AND (o.state IN ('pending', 'rejected')
              OR (o.state = 'claimed' AND o.lease_until < now() AND o.dispatched_at IS NULL))
         AND ${notReconciliation}
         AND (o.after IS NULL
              OR EXISTS (SELECT 1 FROM settlement_operations d
                          WHERE d.id = o.after AND d.state = 'done'))
      RETURNING o.*
    `)
  );
  return rows[0] ? toOperation(rows[0]) : null;
}

/**
 * Recovery takes over an op that has dispatched before — dispatched long ago
 * with no answer, or a takeover claim whose lease ran out before it re-sent —
 * to re-send it after re-reading the evidence, only for kinds whose re-send is
 * safe (L5). `exchange_order` never. An ownership change NEVER touches the
 * financial identity: `attempt` (the idempotency key) and `dispatched_at`
 * (the start of the 23 h replay window) are kept for every kind; only the
 * worker fence `lease_gen` moves. A root_refund is re-sent only within 23 h
 * of its first dispatch.
 */
export async function takeOver(op: Operation, me: string): Promise<Operation | null> {
  const rows = rowsOf(
    await db.execute(sql`
      UPDATE settlement_operations o
         SET state = 'claimed', owner = ${me}, lease_gen = o.lease_gen + 1,
             lease_until = now() + ${lease}, updated_at = now()
       WHERE o.id = ${op.id}
         AND o.lease_gen = ${op.leaseGen}
         AND o.owner IS NOT DISTINCT FROM ${op.owner}
         AND o.dispatched_at IS NOT NULL
         AND ((o.state = 'dispatched' AND o.updated_at < now() - ${lease})
              OR (o.state = 'claimed' AND o.lease_until < now()))
         AND o.kind <> 'exchange_order'
         AND (o.kind <> 'root_refund' OR o.dispatched_at > now() - ${replayWindow})
         AND ${notReconciliation}
      RETURNING o.*
    `)
  );
  return rows[0] ? toOperation(rows[0]) : null;
}

/**
 * Only a returned row authorises the send: the claim must still be ours, at
 * this lease generation, and its lease alive. `dispatched_at` is kept across a
 * root_refund re-send so its 23 h replay window is measured from the first.
 */
export async function dispatch(op: Operation, me: string): Promise<DispatchToken | null> {
  const rows = rowsOf(
    await db.execute(sql`
      UPDATE settlement_operations
         SET state = 'dispatched', dispatched_at = COALESCE(dispatched_at, now()), updated_at = now()
       WHERE id = ${op.id}
         AND owner = ${me}
         AND lease_gen = ${op.leaseGen}
         AND state = 'claimed'
         AND lease_until > now()
      RETURNING *
    `)
  );
  return rows[0] ? (toOperation(rows[0]) as DispatchToken) : null;
}

/** Which row a record may change: the worker's, at this lease generation, in
 *  the state it observed (dispatched, or an expired takeover claim recovery
 *  re-read) — or, for an operator, an unresolved one. */
export type Fence =
  | { state: "dispatched" | "claimed"; owner: string | null; leaseGen: number }
  | { state: "unresolved" };

function fenceSql(id: string, fence: Fence): SQL {
  return fence.state === "unresolved"
    ? sql`id = ${id} AND state = 'unresolved'`
    : sql`id = ${id} AND state = ${fence.state} AND lease_gen = ${fence.leaseGen}
          AND owner IS NOT DISTINCT FROM ${fence.owner}`;
}

/**
 * Shopify said no: the effect provably did not happen. Claimable again — by
 * the next settlement, or by recovery regardless of admission gates. The state
 * and a durable alert (one per op) are ONE statement, so a refusal that keeps
 * repeating is in front of a human, not only in the ledger.
 */
export async function recordRejected(op: Operation, fence: Fence, error: string, resolvedBy?: string) {
  const rows = rowsOf(
    await db.execute(sql`
      WITH r AS (
        UPDATE settlement_operations
           SET state = 'rejected', error = ${error.slice(0, 2000)}, updated_at = now(),
               resolved_by = COALESCE(${resolvedBy ?? null}, resolved_by),
               evidence = COALESCE(${resolvedBy ? JSON.stringify({ operator: error }) : null}::jsonb, evidence)
         WHERE ${fenceSql(op.id, fence)}
        RETURNING id
      ),
      a AS (
        INSERT INTO ops_alerts (dedupe_key, subject, body)
        SELECT 'settlement-rejected:' || r.id,
               ${`[returns] SETTLEMENT REFUSED BY SHOPIFY — ${op.kind} ${op.id}`},
               ${[
                 `Shopify refused settlement operation ${op.id} (${op.kind}, ${op.scopeKey}).`,
                 `Why: ${error.slice(0, 1000)}`,
                 `Amount: ${(op.amountCents / 100).toFixed(2)} ${op.currency}.`,
                 `A refusal means this effect did not happen. Recovery retries it every run;`,
                 `if the cause is permanent, fix it in Shopify or resolve the operation by hand.`,
               ].join("\n")}
          FROM r
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM r)::int AS changed
    `)
  );
  return Number(rows[0]?.changed ?? 0) === 1;
}

/**
 * Only a human decides from here. The state and its durable alert are ONE
 * statement, so the alert exists exactly when the state does.
 */
export async function recordUnresolved(
  op: Operation,
  fence: Fence,
  error: string,
  alert: { subject: string; body: string }
): Promise<boolean> {
  const rows = rowsOf(
    await db.execute(sql`
      WITH u AS (
        UPDATE settlement_operations
           SET state = 'unresolved', error = ${error.slice(0, 2000)}, updated_at = now()
         WHERE ${fenceSql(op.id, fence)}
        RETURNING id
      ),
      a AS (
        INSERT INTO ops_alerts (dedupe_key, subject, body)
        SELECT 'settlement-unresolved:' || u.id, ${alert.subject}, ${alert.body} FROM u
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM u)::int AS changed
    `)
  );
  return Number(rows[0]?.changed ?? 0) === 1;
}

export type DoneExtras = {
  /** exchange_order: the created order's lines, written with the done state. */
  replacementLines?: {
    orderId: string;
    lines: Array<{
      sourceProductsorderId: number;
      lineItemId: string;
      variantGid: string;
      quantity: number;
      stripeFundedCents: number;
    }>;
  };
  /** release_hold: clear the order's pointer to the deleted draft. */
  clearReservation?: { orderId: string; draftOrderId: string };
  resolvedBy?: string;
};

/**
 * What a `done` must carry, whoever records it — the runner or an operator
 * (finding 5). An exchange order's done writes the created order's lines
 * (real Shopify line ids, source line, quantity, funding) in the same
 * statement, one per frozen line; a released hold clears the order's pointer
 * to that draft. A done without them would lose the funding for good, so it
 * is refused before anything is written.
 */
function assertCompletionRecords(op: Operation, extras: DoneExtras): void {
  const request = op.request;
  if (request.kind === "exchange_order") {
    const recorded = extras.replacementLines;
    const frozen = new Set(request.check.lines.map((l) => l.sourceProductsorderId));
    const given = new Set((recorded?.lines ?? []).map((l) => l.sourceProductsorderId));
    if (
      !recorded?.orderId ||
      recorded.lines.length !== frozen.size ||
      given.size !== frozen.size ||
      Array.from(frozen).some((id) => !given.has(id)) ||
      recorded.lines.some((l) => !l.lineItemId)
    ) {
      throw new Error(`exchange_order ${op.id}: done requires its replacement lines, one per frozen line`);
    }
  }
  if (request.kind === "release_hold") {
    const hold = extras.clearReservation;
    if (hold?.orderId !== request.check.orderId || hold?.draftOrderId !== request.check.draftOrderId) {
      throw new Error(`release_hold ${op.id}: done requires clearing the order's reservation pointer`);
    }
  }
}

/** Statements 3 and 4 of finalization: settle every line whose every op is done. */
export function finalizeStatements(submissionId: string): SQL[] {
  return [
    sql`
      UPDATE submission_lines sl
         SET settled_at = now()
       WHERE sl.submission_id = ${submissionId}
         AND sl.settled_at IS NULL
         AND EXISTS (SELECT 1 FROM settlement_operations o
                      WHERE o.submission_id = sl.submission_id
                        AND sl.productsorder_id = ANY (o.members))
         AND NOT EXISTS (SELECT 1 FROM settlement_operations o
                          WHERE o.submission_id = sl.submission_id
                            AND sl.productsorder_id = ANY (o.members)
                            AND o.state <> 'done')
      RETURNING sl.productsorder_id`,
    sql`
      UPDATE productsorder p
         SET refunded = true
        FROM submission_lines sl
       WHERE sl.submission_id = ${submissionId}
         AND sl.settled_at IS NOT NULL
         AND p.id = sl.productsorder_id
         AND p.refunded IS DISTINCT FROM true
      RETURNING p.id`,
  ];
}

const lockSubmission = (submissionId: string) =>
  sql`SELECT id FROM return_submissions WHERE id = ${submissionId} FOR UPDATE`;

/**
 * Record `done` and finalize, as ONE transaction (L4):
 *   1. lock the submission row — finalizers queue here;
 *   2. the op's fenced done write (+ replacement lines / hold pointer);
 *   3. stamp `settled_at` on every line whose every required op is done;
 *   4. `refunded = true` on those rows.
 * READ COMMITTED gives 3 and 4 a fresh snapshot after the lock, so two ops
 * finishing together cannot both miss the line, nor settle it early.
 */
export async function recordDone(
  op: Operation,
  fence: Fence,
  effectRef: string,
  evidence: unknown,
  extras: DoneExtras = {}
): Promise<{ done: boolean; settled: number[] }> {
  assertCompletionRecords(op, extras);
  const ctes: SQL[] = [
    sql`d AS (
      UPDATE settlement_operations
         SET state = 'done', effect_ref = ${effectRef}, evidence = ${JSON.stringify(evidence ?? null)}::jsonb,
             error = NULL, updated_at = now(),
             resolved_by = COALESCE(${extras.resolvedBy ?? null}, resolved_by)
       WHERE ${fenceSql(op.id, fence)}
      RETURNING id, submission_id)`,
  ];
  if (extras.replacementLines) {
    const lines = extras.replacementLines.lines.map((l) => ({
      source_productsorder_id: l.sourceProductsorderId,
      line_item_id: l.lineItemId,
      variant_id: l.variantGid,
      quantity: l.quantity,
      stripe_funded_cents: l.stripeFundedCents,
    }));
    ctes.push(sql`rl AS (
      INSERT INTO replacement_lines
        (exchange_operation_id, source_submission_id, source_productsorder_id, order_id,
         line_item_id, variant_id, quantity, stripe_funded_cents)
      SELECT d.id, d.submission_id, r.source_productsorder_id, ${extras.replacementLines.orderId},
             r.line_item_id, r.variant_id, r.quantity, r.stripe_funded_cents
        FROM d, jsonb_to_recordset(${JSON.stringify(lines)}::jsonb) AS r(
          source_productsorder_id integer, line_item_id text, variant_id text,
          quantity integer, stripe_funded_cents integer)
      ON CONFLICT DO NOTHING
      RETURNING 1)`);
  }
  if (extras.clearReservation) {
    ctes.push(sql`hold AS (
      UPDATE orders SET exchange_reservation_id = NULL
        FROM d
       WHERE orders.id = ${extras.clearReservation.orderId}
         AND orders.exchange_reservation_id = ${extras.clearReservation.draftOrderId}
      RETURNING 1)`);
  }
  const doneStatement = sql`WITH ${sql.join(ctes, sql`, `)} SELECT count(*)::int AS done FROM d`;

  const [, doneRows, settledRows] = await transact([
    lockSubmission(op.submissionId),
    doneStatement,
    ...finalizeStatements(op.submissionId),
  ]);
  return {
    done: Number(doneRows?.[0]?.done ?? 0) === 1,
    settled: (settledRows ?? []).map((r: any) => Number(r.productsorder_id)),
  };
}

/** Finalization alone, for recovery: a done op whose line was never settled. */
export async function finalize(submissionId: string): Promise<number[]> {
  const [, settledRows] = await transact([
    lockSubmission(submissionId),
    ...finalizeStatements(submissionId),
  ]);
  return (settledRows ?? []).map((r: any) => Number(r.productsorder_id));
}

// ── L5: what recovery looks at ─────────────────────────────────────────────

/** Ops recovery must move (L5), independent of every admission gate:
 *  pending and rejected ops with their dependency met (a fresh send — a
 *  rejection proved nothing happened, and a closed return must not strand it,
 *  finding 4), claims whose lease ran out, and dispatches unanswered for longer
 *  than a lease. An expired claim that had dispatched is routed by the caller
 *  to `recoverDispatched` (evidence first), never to `run`. */
export async function recoverableOperations(limit: number): Promise<Operation[]> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT o.* FROM settlement_operations o
       WHERE ((o.state IN ('pending', 'rejected')
               AND (o.after IS NULL
                    OR EXISTS (SELECT 1 FROM settlement_operations d
                                WHERE d.id = o.after AND d.state = 'done')))
           OR (o.state = 'claimed' AND o.lease_until < now())
           OR (o.state = 'dispatched' AND o.updated_at < now() - ${lease}))
         AND ${notReconciliation}
       ORDER BY o.created_at, o.scope_key
       LIMIT ${limit}
    `)
  );
  return rows.map(toOperation);
}

/** An op that has dispatched before may only be re-entered through evidence
 *  and replay (`recoverDispatched`), never claimed afresh. */
export const hasDispatched = (op: Operation): boolean =>
  op.state === "dispatched" || (op.state === "claimed" && op.dispatchedAt !== null);

/** Submissions with a done op and a line still unsettled. */
export async function submissionsToFinalize(): Promise<string[]> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT DISTINCT sl.submission_id
        FROM submission_lines sl
       WHERE sl.settled_at IS NULL
         AND EXISTS (SELECT 1 FROM settlement_operations o
                      WHERE o.submission_id = sl.submission_id AND o.state = 'done')
    `)
  );
  return rows.map((r) => String(r.submission_id));
}

/** Cancellations that took a submission over an hour ago and never finished. */
export async function stuckCancellations(): Promise<Array<{ id: string; orderId: string }>> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT id, order_id FROM return_submissions
       WHERE holder = 'cancellation' AND state <> 'cancelled'
         AND holder_since < now() - interval '1 hour'
    `)
  );
  return rows.map((r) => ({ id: String(r.id), orderId: String(r.order_id) }));
}

/**
 * An operator's "no payment happened" on an unresolved reconciliation record.
 * Fenced on `unresolved` and on the submission being `reconciled`; no alert —
 * nothing was refused by Shopify. The line then reads as unpaid to the next
 * reconciliation run, and is paid only once Santi approves it.
 */
export async function recordReconciliationRejected(opId: string, evidence: string, by: string): Promise<boolean> {
  const rows = rowsOf(
    await db.execute(sql`
      UPDATE settlement_operations o
         SET state = 'rejected', error = ${evidence.slice(0, 2000)}, resolved_by = ${by},
             evidence = ${JSON.stringify({ operator: evidence })}::jsonb, updated_at = now()
       WHERE o.id = ${opId}
         AND o.state = 'unresolved'
         AND EXISTS (SELECT 1 FROM return_submissions s WHERE s.id = o.submission_id AND s.state = 'reconciled')
      RETURNING o.id
    `)
  );
  return rows.length === 1;
}
