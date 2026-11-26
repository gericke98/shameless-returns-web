// The database half of the settlement ledger (drizzle/0007, S2 plan L2–L5).
//
// Every transition is ONE conditional statement — `UPDATE … WHERE state = …
// RETURNING` — and the row's state, never a prior read, decides who wins.
// Finalization is one non-interactive transaction (`transact`) serialised on
// the submission row lock. No interactive transaction is ever opened.
//
// NOT "use server": nothing here may be callable from a browser.
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import db, { readQuery, writeDb } from "@/db/drizzle";
import type { WriteCapability } from "@/lib/server/identity";
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
                                           WHERE rs.id = o.submission_id AND rs.state IN ('reconciled', 'voided'))`;
const replayWindow = sql.raw(`interval '${ROOT_REFUND_REPLAY_HOURS} hours'`);

/**
 * FX §#7: a hold that blocks settlement of a submission — open, or resolved by
 * hand (`manual`: Santi settled it himself; nothing of it is ever planned or
 * sent again). A `release`d hold blocks nothing.
 */
const blockingHold = (submissionId: SQL) => sql`EXISTS (
  SELECT 1 FROM settlement_holds bh
   WHERE bh.submission_id = ${submissionId}
     AND (bh.resolved_at IS NULL OR bh.resolution = 'manual'))`;

/** A2: an operator owns the submission (`holder = 'manual'`): nothing automated touches it. */
const takenByHand = (submissionId: SQL) => sql`EXISTS (
  SELECT 1 FROM return_submissions th WHERE th.id = ${submissionId} AND th.holder = 'manual')`;

/**
 * A3: an operation frozen in a shape FX no longer runs — read from its frozen
 * request (explicit data), never from deploy timing:
 *   - an exchange_order not obeying the shop's inventory policy;
 *   - a release_hold (no stock-hold draft exists any more);
 *   - any other op of a submission that has an exchange_order, whose own
 *     `after` is not that exchange (it could move before the order exists).
 * `o` is the settlement_operations alias the predicate is evaluated on.
 */
const legacyShape = (o: SQL) => sql`(
  (${o}.kind = 'exchange_order'
     AND (${o}.request #>> '{variables,options,inventoryBehaviour}') IS DISTINCT FROM 'DECREMENT_OBEYING_POLICY')
  OR ${o}.kind = 'release_hold'
  OR (${o}.kind <> 'exchange_order'
      AND EXISTS (SELECT 1 FROM settlement_operations lx
                   WHERE lx.submission_id = ${o}.submission_id AND lx.kind = 'exchange_order'
                     AND ${o}.after IS DISTINCT FROM lx.id)))`;

/** The order number for a hold's alert, read in the statement that writes it. */
const orderNumberOf = (submissionId: SQL) => sql`COALESCE(
  (SELECT ho.order_number FROM return_submissions hs JOIN orders ho ON ho.id = hs.order_id
    WHERE hs.id = ${submissionId}), '(unknown order)')`;

export type HoldCause = "stock-short" | "exchange-rejected" | "legacy-plan";

/**
 * The durable alert a hold writes in its own statement (outbox key
 * `settlement-held:<hold id>`): the order, the submission, the cause, what
 * is short or what Shopify said, and the commands that resolve it. `{order}`
 * is filled in SQL with the order number.
 */
export function holdAlert(holdId: string, submissionId: string, cause: HoldCause, detail: string[]) {
  return {
    dedupeKey: `settlement-held:${holdId}`,
    subject: `[returns] SETTLEMENT HELD — ${cause} — order {order}`,
    body: [
      `Settlement of order {order} (submission ${submissionId}) is HELD: ${cause}.`,
      ...detail,
      ``,
      `Nothing of this submission is planned or sent until the hold is resolved:`,
      `  release (re-check Amphora on the next run):`,
      `    npx tsx --conditions=react-server --tsconfig tsconfig.scripts.json scripts/resolve-hold.ts --hold ${holdId} --release --evidence "<why>" --write`,
      `  settle it by hand — take it FIRST, before touching Shopify or Stripe, then record it:`,
      `    npx tsx --conditions=react-server --tsconfig tsconfig.scripts.json scripts/resolve-hold.ts --hold ${holdId} --take --by <you> --write`,
      `    npx tsx --conditions=react-server --tsconfig tsconfig.scripts.json scripts/resolve-hold.ts --hold ${holdId} --done --evidence "<what was done>" --write`,
    ].join("\n"),
  };
}

/** The alert columns of a hold's outbox row, with `{order}` resolved in SQL. */
const holdAlertColumns = (alert: ReturnType<typeof holdAlert>, submissionId: SQL) => sql`
  ${alert.dedupeKey},
  replace(${alert.subject}, '{order}', ${orderNumberOf(submissionId)}),
  replace(${alert.body}, '{order}', ${orderNumberOf(submissionId)})`;

// ── reads ──────────────────────────────────────────────────────────────────

export async function getOperation(id: string): Promise<Operation | null> {
  const rows = rowsOf(await readQuery(sql`SELECT * FROM settlement_operations WHERE id = ${id}`));
  return rows[0] ? toOperation(rows[0]) : null;
}

export async function operationsOf(submissionId: string): Promise<Operation[]> {
  const rows = rowsOf(
    await readQuery(
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
    await readQuery(sql`SELECT * FROM return_submissions WHERE id = ${submissionId}`)
  );
  if (!s) return null;
  const lines = rowsOf(
    await readQuery(
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
  // Read-only by construction (F1 spec §10): shared with admission and admin
  // approvals, so it takes no order capability; Postgres refuses any write.
  const rows = rowsOf(
    await readQuery(sql`
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
    await readQuery(sql`
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
 *
 * The one exception is explicit data: a `swap` approval (drizzle/0010, D1)
 * pays the owed part of an exchange the reconciliation found DONE — so a done
 * `exchange_order` record does not hold a line approved on that basis. Pass
 * the lines' approval bases in `approved`.
 */
export async function standingReconciliations(
  productsorderIds: readonly number[],
  approved: ReadonlyMap<number, ApprovalBasis> = new Map()
): Promise<Map<number, { opId: string; state: string; kind: string }>> {
  if (productsorderIds.length === 0) return new Map();
  // Read-only by construction (F1 spec §10), as `submissionOfRow`.
  const rows = rowsOf(
    await readQuery(sql`
      SELECT m.po, o.id, o.state, o.kind
        FROM settlement_operations o
        JOIN return_submissions s ON s.id = o.submission_id AND s.state = 'reconciled'
        CROSS JOIN LATERAL unnest(o.members) AS m(po)
       WHERE o.state <> 'rejected'
         AND m.po IN (SELECT (jsonb_array_elements_text(${JSON.stringify(productsorderIds)}::jsonb))::int)
    `)
  );
  const out = new Map<number, { opId: string; state: string; kind: string }>();
  for (const r of rows) {
    const po = Number(r.po);
    const swapOverDoneExchange = approved.get(po) === "swap" && r.state === "done" && r.kind === "exchange_order";
    if (!swapOverDoneExchange) out.set(po, { opId: String(r.id), state: String(r.state), kind: String(r.kind) });
  }
  return out;
}

export type ApprovalBasis = "unpaid" | "swap";
export type Approval = { productsorderId: number; basis: ApprovalBasis; amountCents: number };

/** Santi's approvals (drizzle/0010) recorded with this submission, by line. */
export async function approvalsOf(submissionId: string): Promise<Map<number, Approval>> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT productsorder_id, basis, amount_cents FROM settlement_approvals WHERE submission_id = ${submissionId}
    `)
  );
  return new Map(
    rows.map((r) => [
      Number(r.productsorder_id),
      { productsorderId: Number(r.productsorder_id), basis: r.basis as ApprovalBasis, amountCents: Number(r.amount_cents) },
    ])
  );
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
 * statement. Zero rows from `s` means a concurrent admission (or hold) bumped
 * the sequence, a cancellation or an operator holds the submission, or a hold
 * blocks it (FX §#7): nothing is written.
 */
export async function insertAdmission(cap: WriteCapability, input: {
  submissionId: string;
  seenSeq: number;
  ops: NewOperation[];
  reverseFulfillment: Array<{ productsorder_id: number; rfo: string }>;
}): Promise<{ admitted: boolean; inserted: number }> {
  const result = await writeDb(cap).execute(sql`
    WITH s AS (
      UPDATE return_submissions
         SET admission_seq = admission_seq + 1,
             holder_since = CASE WHEN holder = 'settlement' THEN holder_since ELSE now() END,
             holder = 'settlement'
       WHERE id = ${input.submissionId}
         AND admission_seq = ${input.seenSeq}
         AND state = 'accepted'
         AND (holder IS NULL OR holder = 'settlement')
         AND NOT ${blockingHold(sql`return_submissions.id`)}
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

// ── FX §#7: holds, on the admission fence ─────────────────────────────────

export type ShortfallDetail = Array<{ sku: string; need: number; available: number; earlier: number }>;

const shortfallLines = (short: ShortfallDetail) =>
  short.map((x) => `  ${x.sku}: need ${x.need}, Amphora available ${x.available}, promised earlier ${x.earlier}`);

/**
 * Admission found Amphora short: hold the submission instead of planning it.
 * ONE statement: the submission CAS (exactly insertAdmission's), the hold
 * row, its outbox row. A worker that read "enough" and one that recorded
 * "short" on the same seen sequence cannot both win.
 */
export async function insertHold(cap: WriteCapability, input: {
  submissionId: string;
  seenSeq: number;
  short: ShortfallDetail;
}): Promise<{ held: boolean; holdId: string }> {
  const holdId = randomUUID();
  const alert = holdAlert(holdId, input.submissionId, "stock-short", [
    `Amphora cannot cover the replacement:`,
    ...shortfallLines(input.short),
  ]);
  const result = await writeDb(cap).execute(sql`
    WITH s AS (
      UPDATE return_submissions
         SET admission_seq = admission_seq + 1
       WHERE id = ${input.submissionId}
         AND admission_seq = ${input.seenSeq}
         AND state = 'accepted'
         AND (holder IS NULL OR holder = 'settlement')
      RETURNING id
    ),
    h AS (
      INSERT INTO settlement_holds (id, submission_id, cause, detail)
      SELECT ${holdId}, s.id, 'stock-short', ${JSON.stringify({ short: input.short })}::jsonb FROM s
      ON CONFLICT (submission_id) WHERE resolved_at IS NULL DO NOTHING
      RETURNING id, submission_id
    ),
    a AS (
      INSERT INTO ops_alerts (dedupe_key, subject, body)
      SELECT ${holdAlertColumns(alert, sql`h.submission_id`)} FROM h
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM h)::int AS held
  `);
  return { held: Number(rowsOf(result)[0]?.held ?? 0) === 1, holdId };
}

export type Hold = {
  id: string;
  submissionId: string;
  cause: HoldCause;
  exchangeOperationId: string | null;
  detail: unknown;
  createdAt: Date;
  takenBy: string | null;
  takenAt: Date | null;
  resolution: "release" | "manual" | null;
  resolvedAt: Date | null;
};

function toHold(row: any): Hold {
  return {
    id: String(row.id),
    submissionId: String(row.submission_id),
    cause: row.cause,
    exchangeOperationId: row.exchange_operation_id ? String(row.exchange_operation_id) : null,
    detail: typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail,
    createdAt: new Date(row.created_at),
    takenBy: row.taken_by ?? null,
    takenAt: row.taken_at ? new Date(row.taken_at) : null,
    resolution: row.resolution ?? null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
  };
}

/** The hold that blocks this submission now — the open one, else one resolved by hand — or null. */
export async function holdOf(submissionId: string): Promise<Hold | null> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT * FROM settlement_holds
       WHERE submission_id = ${submissionId}
         AND (resolved_at IS NULL OR resolution = 'manual')
       ORDER BY (resolved_at IS NULL) DESC, created_at DESC
       LIMIT 1
    `)
  );
  return rows[0] ? toHold(rows[0]) : null;
}

export async function getHold(holdId: string): Promise<Hold | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(holdId)) return null;
  const rows = rowsOf(await readQuery(sql`SELECT * FROM settlement_holds WHERE id = ${holdId}`));
  return rows[0] ? toHold(rows[0]) : null;
}

/** A2: holds an operator took to settle by hand and has not recorded as done for a day. */
export async function takenHoldsNotDone(): Promise<Array<{ id: string; submissionId: string; takenBy: string; takenAt: Date }>> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT id, submission_id, taken_by, taken_at FROM settlement_holds
       WHERE resolved_at IS NULL AND taken_at IS NOT NULL AND taken_at < now() - interval '24 hours'
       ORDER BY taken_at
    `)
  );
  return rows.map((r) => ({
    id: String(r.id),
    submissionId: String(r.submission_id),
    takenBy: String(r.taken_by),
    takenAt: new Date(r.taken_at),
  }));
}

/** One open replacement promise (FX §#2, D2). */
export type OpenDemand = { submissionId: string; acceptedAt: Date; variantGid: string; quantity: number };

/**
 * Every replacement still promised to a customer: CAMBIO lines of accepted
 * submissions not being cancelled, not settled (in the ledger, or outside it:
 * `refunded`), not covered by an approval (money only, D1), whose
 * submission's exchange order is not done (or voided), and not settled by
 * hand. An open hold's demand still counts (decision 3). `s` is the demand's
 * return_submissions alias.
 */
const openDemandWhere = sql`
         sl.action = 'CAMBIO'
     AND s.state = 'accepted'
     AND s.holder IS DISTINCT FROM 'cancellation'
     AND sl.settled_at IS NULL
     AND p.refunded IS NOT TRUE
     AND NOT EXISTS (SELECT 1 FROM settlement_approvals a
                      WHERE a.productsorder_id = sl.productsorder_id AND a.submission_id = sl.submission_id)
     AND NOT EXISTS (SELECT 1 FROM settlement_operations o
                      WHERE o.submission_id = s.id AND o.kind = 'exchange_order' AND o.state IN ('done', 'void'))
     AND NOT EXISTS (SELECT 1 FROM settlement_holds h
                      WHERE h.submission_id = s.id AND h.resolution = 'manual')`;

const toDemand = (r: any): OpenDemand => ({
  submissionId: String(r.submission_id),
  acceptedAt: new Date(r.accepted_at),
  variantGid: String(r.new_variant_id),
  quantity: Number(r.quantity),
});

/** All open demand (accept time: the customer's basket is part of none of it). */
export async function openExchangeDemand(): Promise<OpenDemand[]> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT sl.submission_id::text AS submission_id, s.accepted_at, sl.new_variant_id, sl.quantity
        FROM submission_lines sl
        JOIN return_submissions s ON s.id = sl.submission_id
        JOIN productsorder p ON p.id = sl.productsorder_id
       WHERE ${openDemandWhere}
       ORDER BY s.accepted_at, sl.submission_id, sl.productsorder_id
    `)
  );
  return rows.map(toDemand);
}

/**
 * Settlement's earlier demand (D2): the open demand of submissions accepted
 * at or before `submissionId`, itself excluded. Equal stamps count both ways
 * (no tie-breaker). The boundary is that submission's own stored
 * `accepted_at`, looked up by its id INSIDE the query — never a value read
 * out and passed back (a JS Date keeps milliseconds; Postgres keeps
 * microseconds, review #3). `null`: the submission does not exist or has no
 * `accepted_at` — never "earliest".
 */
export async function earlierExchangeDemand(submissionId: string): Promise<OpenDemand[] | null> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT m.accepted_at IS NOT NULL AS known,
             d.submission_id, d.accepted_at, d.new_variant_id, d.quantity
        FROM (SELECT accepted_at FROM return_submissions WHERE id = ${submissionId}) m
        LEFT JOIN LATERAL (
          SELECT sl.submission_id::text AS submission_id, s.accepted_at, sl.new_variant_id, sl.quantity,
                 sl.productsorder_id
            FROM submission_lines sl
            JOIN return_submissions s ON s.id = sl.submission_id
            JOIN productsorder p ON p.id = sl.productsorder_id
           WHERE ${openDemandWhere}
             AND s.accepted_at <= m.accepted_at
             AND s.id <> ${submissionId}
        ) d ON true
       ORDER BY d.accepted_at, d.submission_id, d.productsorder_id
    `)
  );
  if (rows.length === 0 || rows[0].known !== true) return null;
  return rows.filter((r) => r.submission_id !== null && r.submission_id !== undefined).map(toDemand);
}

// ── L4: claim → dispatch → record ──────────────────────────────────────────

/**
 * A3's hold, as CTEs `seq`, `h`, `a` that follow a CTE `legacy(id,
 * submission_id)` naming the refused op. The submission fence comes FIRST
 * (§#7: the admission_seq bump takes the submission row lock before the hold
 * row is written — the order every hold writer and dispatch lock in; the hold
 * first, the row second, deadlocked against insertHold), unless a blocking
 * hold or a manual holder is already there; then the `legacy-plan` hold
 * listing every not-done legacy op of the submission; then its outbox row.
 */
function legacyHoldCtes(detail: string[]): SQL {
  const holdId = randomUUID();
  const alert = holdAlert(holdId, "{submission}", "legacy-plan", detail);
  return sql`
      seq AS (
        UPDATE return_submissions rs SET admission_seq = rs.admission_seq + 1
          FROM legacy l
         WHERE rs.id = l.submission_id
           AND NOT ${blockingHold(sql`rs.id`)}
           AND NOT ${takenByHand(sql`rs.id`)}
        RETURNING rs.id AS submission_id
      ),
      h AS (
        INSERT INTO settlement_holds (id, submission_id, cause, detail)
        SELECT ${holdId}, f.submission_id, 'legacy-plan',
               jsonb_build_object('operations',
                 (SELECT jsonb_agg(x.id ORDER BY x.created_at, x.scope_key) FROM settlement_operations x
                   WHERE x.submission_id = f.submission_id AND x.state NOT IN ('done', 'void')
                     AND ${legacyShape(sql`x`)}))
          FROM seq f
        ON CONFLICT (submission_id) WHERE resolved_at IS NULL DO NOTHING
        RETURNING id, submission_id
      ),
      a AS (
        INSERT INTO ops_alerts (dedupe_key, subject, body)
        SELECT ${alert.dedupeKey},
               replace(${alert.subject}, '{order}', ${orderNumberOf(sql`h.submission_id`)}),
               replace(replace(${alert.body}, '{order}', ${orderNumberOf(sql`h.submission_id`)}),
                       '{submission}', h.submission_id::text)
          FROM h
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING 1
      )`;
}

/**
 * Claim an op that may be SENT AFRESH: a pending op (never sent) or a
 * rejected one (Shopify said no, so nothing happened) — those two start a new
 * financial attempt and forget any earlier dispatch. A claim whose lease ran
 * out is reclaimed only if it never dispatched (`dispatched_at IS NULL`), and
 * keeps its attempt. Anything that ever dispatched is NOT claimable here: it
 * goes back through evidence and replay via `takeOver` (finding 1).
 * Every claim moves `lease_gen`, the worker fence.
 *
 * FX: never while a hold blocks the submission (§#7) or an operator holds it
 * (A2). An op frozen in a legacy shape (A3) is never claimed: the same
 * statement records a `legacy-plan` hold for its submission (naming every
 * such op), bumps its admission sequence, and writes the hold's outbox row.
 */
export async function claim(cap: WriteCapability, opId: string, me: string): Promise<Operation | null> {
  const legacyHold = legacyHoldCtes([
    `An operation was admitted in a shape this code no longer runs (an exchange that ignores the`,
    `inventory policy, a stock-hold release, or a sibling not gated on the exchange). Nothing was sent.`,
    `Void those operations (or settle by hand with --take/--done) before releasing.`,
  ]);
  const rows = rowsOf(
    await writeDb(cap).execute(sql`
      WITH legacy AS (
        SELECT o.id, o.submission_id FROM settlement_operations o
         WHERE o.id = ${opId}
           AND (o.state IN ('pending', 'rejected')
                OR (o.state = 'claimed' AND o.lease_until < now() AND o.dispatched_at IS NULL))
           AND ${notReconciliation}
           AND ${legacyShape(sql`o`)}
      ),
      c AS (
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
           AND NOT ${blockingHold(sql`o.submission_id`)}
           AND NOT ${takenByHand(sql`o.submission_id`)}
           AND NOT EXISTS (SELECT 1 FROM legacy)
        RETURNING o.*
      ),
      ${legacyHold}
      SELECT * FROM c
    `)
  );
  return rows[0] ? toOperation(rows[0]) : null;
}

/**
 * Recovery takes over an op that has dispatched before — dispatched long ago
 * with no answer, or a takeover claim whose lease ran out — to re-send it
 * after re-reading the evidence, only for kinds whose re-send is safe (L5).
 * `exchange_order` never. An ownership change NEVER touches the financial
 * identity: `attempt` (the idempotency key) and `dispatched_at` (the start of
 * the 23 h replay window) are kept for every kind; only the worker fence
 * `lease_gen` moves. A root_refund is re-sent only within 23 h of its first
 * dispatch.
 *
 * FX (review #1): a re-send is a send, so it is authorized exactly as
 * `claim` authorizes one — never while its `after` op is not done, a hold
 * blocks the submission (§#7) or an operator holds it (A2). An op frozen in a
 * legacy shape (A3) is never re-sent: absence of evidence does not authorize
 * its replay. The same statement records the `legacy-plan` hold (as `claim`
 * does); the op stays `dispatched`, observed and completed from evidence only.
 */
/**
 * What a takeover found. `taken`: this worker may re-send. `refused`: the op
 * is ours to take over (same fence, aged, replayable kind) but a re-send is not
 * authorized — legacy shape, `after` not done, a blocking hold, a manual
 * holder. `not-ours`: another worker moved it, or it is not takeover-eligible.
 */
export type TakeOverResult = { kind: "taken"; op: Operation } | { kind: "refused" } | { kind: "not-ours" };

export async function takeOver(cap: WriteCapability, op: Operation, me: string): Promise<TakeOverResult> {
  const legacyHold = legacyHoldCtes([
    `An operation in a shape this code no longer runs (a stock-hold release, or a sibling not gated on`,
    `the exchange) was sent before and Shopify shows no effect. It is NOT re-sent: it is recorded`,
    `unresolved for a human. Check Shopify by hand, then resolve it with resolve-operation`,
    `(--done if the effect exists; --rejected ONLY when Shopify proves it never happened).`,
  ]);
  const replayable = sql`
           o.id = ${op.id}
       AND o.lease_gen = ${op.leaseGen}
       AND o.owner IS NOT DISTINCT FROM ${op.owner}
       AND o.dispatched_at IS NOT NULL
       AND ((o.state = 'dispatched' AND o.updated_at < now() - ${lease})
            OR (o.state = 'claimed' AND o.lease_until < now()))
       AND o.kind <> 'exchange_order'
       AND (o.kind <> 'root_refund' OR o.dispatched_at > now() - ${replayWindow})
       AND ${notReconciliation}`;
  const rows = rowsOf(
    await writeDb(cap).execute(sql`
      WITH legacy AS (
        SELECT o.id, o.submission_id FROM settlement_operations o
         WHERE ${replayable}
           AND ${legacyShape(sql`o`)}
      ),
      t AS (
        UPDATE settlement_operations o
           SET state = 'claimed', owner = ${me}, lease_gen = o.lease_gen + 1,
               lease_until = now() + ${lease}, updated_at = now()
         WHERE ${replayable}
           AND (o.after IS NULL
                OR EXISTS (SELECT 1 FROM settlement_operations d
                            WHERE d.id = o.after AND d.state = 'done'))
           AND NOT ${blockingHold(sql`o.submission_id`)}
           AND NOT ${takenByHand(sql`o.submission_id`)}
           AND NOT EXISTS (SELECT 1 FROM legacy)
        RETURNING o.*
      ),
      ${legacyHold}
      SELECT t.*, true AS taken FROM t
      UNION ALL
      SELECT o.*, false AS taken FROM settlement_operations o
       WHERE ${replayable} AND NOT EXISTS (SELECT 1 FROM t)
    `)
  );
  const row = rows[0];
  if (!row) return { kind: "not-ours" };
  return row.taken === true ? { kind: "taken", op: toOperation(row) } : { kind: "refused" };
}

/**
 * Only a returned row authorises the send: the claim must still be ours, at
 * this lease generation, and its lease alive. `dispatched_at` is kept across a
 * root_refund re-send so its 23 h replay window is measured from the first.
 *
 * FX §#7 (review #2): dispatch takes part in the submission's serialization,
 * the F1 §10 pattern (`claimForCancellation`). ONE transaction: (1) locks the
 * submission row — the lock every hold writer takes through its
 * `admission_seq` bump; (2) runs on a fresh READ COMMITTED snapshot taken
 * after that lock, so a hold committed after this op was claimed (A3 on a
 * sibling, a rejected exchange, A1 short, an operator's --take) is seen and
 * the claim is NOT turned into a send. A hold writer that comes second waits
 * on (1) and commits after the send was authorized, which is its true order.
 */
export async function dispatch(cap: WriteCapability, op: Operation, me: string): Promise<DispatchToken | null> {
  const [, rows] = await writeDb(cap).transact([
    sql`
      SELECT rs.id FROM return_submissions rs
       WHERE rs.id = (SELECT so.submission_id FROM settlement_operations so WHERE so.id = ${op.id})
       FOR UPDATE`,
    sql`
      UPDATE settlement_operations o
         SET state = 'dispatched', dispatched_at = COALESCE(o.dispatched_at, now()), updated_at = now()
       WHERE o.id = ${op.id}
         AND o.owner = ${me}
         AND o.lease_gen = ${op.leaseGen}
         AND o.state = 'claimed'
         AND o.lease_until > now()
         AND NOT ${blockingHold(sql`o.submission_id`)}
         AND NOT ${takenByHand(sql`o.submission_id`)}
      RETURNING o.*`,
  ]);
  return rows?.[0] ? (toOperation(rows[0]) as DispatchToken) : null;
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
 *
 * FX §#4: a rejected `exchange_order` is NOT re-sent every recovery run. The
 * same statement writes an `exchange-rejected` hold for its submission (so
 * `claim` refuses every op of it), bumps the submission's admission sequence,
 * and writes the hold's outbox row in place of the generic one. Only an
 * operator's `--release` makes it claimable again (and then A1 re-checks
 * Amphora before the new attempt).
 */
export async function recordRejected(cap: WriteCapability, op: Operation, fence: Fence, error: string, resolvedBy?: string) {
  const update = sql`
      r AS (
        UPDATE settlement_operations
           SET state = 'rejected', error = ${error.slice(0, 2000)}, updated_at = now(),
               resolved_by = COALESCE(${resolvedBy ?? null}, resolved_by),
               evidence = COALESCE(${resolvedBy ? JSON.stringify({ operator: error }) : null}::jsonb, evidence)
         WHERE ${fenceSql(op.id, fence)}
        RETURNING id, submission_id
      )`;
  if (op.kind === "exchange_order") {
    const holdId = randomUUID();
    const alert = holdAlert(holdId, op.submissionId, "exchange-rejected", [
      `Shopify refused the replacement order (operation ${op.id}), so it does not exist:`,
      `  ${error.slice(0, 1000)}`,
      `No goods or money of this submission move while it is held.`,
    ]);
    const rows = rowsOf(
      await writeDb(cap).execute(sql`
        WITH ${update},
        seq AS (
          -- The submission row lock BEFORE the hold row (§#7 lock order; see legacyHoldCtes).
          UPDATE return_submissions rs SET admission_seq = rs.admission_seq + 1
            FROM r WHERE rs.id = r.submission_id
          RETURNING r.id AS operation_id, r.submission_id
        ),
        h AS (
          INSERT INTO settlement_holds (id, submission_id, cause, exchange_operation_id, detail)
          SELECT ${holdId}, f.submission_id, 'exchange-rejected', f.operation_id,
                 ${JSON.stringify({ error: error.slice(0, 2000) })}::jsonb
            FROM seq f
          ON CONFLICT (submission_id) WHERE resolved_at IS NULL DO NOTHING
          RETURNING id, submission_id
        ),
        a AS (
          INSERT INTO ops_alerts (dedupe_key, subject, body)
          SELECT ${holdAlertColumns(alert, sql`h.submission_id`)} FROM h
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM r)::int AS changed
      `)
    );
    return Number(rows[0]?.changed ?? 0) === 1;
  }
  const rows = rowsOf(
    await writeDb(cap).execute(sql`
      WITH ${update},
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
 * A1 (FX amendment): Amphora could not authorize a fresh orderCreate this
 * worker claimed. ONE statement, fenced on the claim (owner, lease_gen, never
 * dispatched): the op goes back to `pending` with its owner and lease cleared
 * and the attempt it took returned (so nothing is consumed). With `short`,
 * the same statement also passes the submission's admission CAS, writes a
 * `stock-short` hold and its outbox row — the open hold then blocks `claim`.
 * Without it (Amphora unreadable: transient), nothing else is written.
 */
export async function returnClaimForStock(
  cap: WriteCapability,
  op: Operation,
  me: string,
  short: { seenSeq: number; short: ShortfallDetail } | null
): Promise<boolean> {
  const back = (from: SQL) => sql`
      r AS (
        UPDATE settlement_operations o
           SET state = 'pending', owner = NULL, lease_until = NULL,
               attempt = GREATEST(o.attempt - 1, 0), updated_at = now()
          ${from}
         WHERE o.id = ${op.id} AND o.state = 'claimed' AND o.owner = ${me}
           AND o.lease_gen = ${op.leaseGen} AND o.dispatched_at IS NULL
        RETURNING o.id, o.submission_id
      )`;
  if (!short) {
    const rows = rowsOf(
      await writeDb(cap).execute(sql`WITH ${back(sql``)} SELECT (SELECT count(*) FROM r)::int AS changed`)
    );
    return Number(rows[0]?.changed ?? 0) === 1;
  }
  const holdId = randomUUID();
  const alert = holdAlert(holdId, op.submissionId, "stock-short", [
    `Amphora cannot cover the replacement order (operation ${op.id}) at the moment it was about to be sent:`,
    ...shortfallLines(short.short),
    `It was NOT sent.`,
  ]);
  const rows = rowsOf(
    await writeDb(cap).execute(sql`
      WITH s AS (
        UPDATE return_submissions
           SET admission_seq = admission_seq + 1
         WHERE id = ${op.submissionId} AND admission_seq = ${short.seenSeq}
        RETURNING id
      ),
      ${back(sql`FROM s`)},
      h AS (
        INSERT INTO settlement_holds (id, submission_id, cause, detail)
        SELECT ${holdId}, r.submission_id, 'stock-short',
               ${JSON.stringify({ operation: op.id, short: short.short })}::jsonb
          FROM r
        ON CONFLICT (submission_id) WHERE resolved_at IS NULL DO NOTHING
        RETURNING id, submission_id
      ),
      a AS (
        INSERT INTO ops_alerts (dedupe_key, subject, body)
        SELECT ${holdAlertColumns(alert, sql`h.submission_id`)} FROM h
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
  cap: WriteCapability,
  op: Operation,
  fence: Fence,
  error: string,
  alert: { subject: string; body: string }
): Promise<boolean> {
  const rows = rowsOf(
    await writeDb(cap).execute(sql`
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
  /** S3: a legacy exchange order an operator found — recorded as a
   *  replacement by id (drizzle/0011), with no funding (Codex #3/#5). */
  replacementIdentity?: { orderId: string; sourceOrderId: string };
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
  cap: WriteCapability,
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
  if (extras.replacementIdentity) {
    ctes.push(sql`ident AS (
      INSERT INTO legacy_replacement_orders (order_id, source_order_id, found_by)
      SELECT ${extras.replacementIdentity.orderId}, ${extras.replacementIdentity.sourceOrderId}, 'operator' FROM d
      ON CONFLICT (order_id) DO UPDATE
        SET source_order_id = COALESCE(legacy_replacement_orders.source_order_id, EXCLUDED.source_order_id)
      RETURNING 1)`);
  }
  const doneStatement = sql`WITH ${sql.join(ctes, sql`, `)} SELECT count(*)::int AS done FROM d`;

  const [, doneRows, settledRows] = await writeDb(cap).transact([
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
export async function finalize(cap: WriteCapability, submissionId: string): Promise<number[]> {
  const [, settledRows] = await writeDb(cap).transact([
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
    await readQuery(sql`
      SELECT o.* FROM settlement_operations o
       WHERE ((o.state IN ('pending', 'rejected')
               AND (o.after IS NULL
                    OR EXISTS (SELECT 1 FROM settlement_operations d
                                WHERE d.id = o.after AND d.state = 'done'))
               -- FX §#7 / A2: a held submission, or one an operator took, is not moved.
               AND NOT ${blockingHold(sql`o.submission_id`)}
               AND NOT ${takenByHand(sql`o.submission_id`)})
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

/**
 * Santi's approvals (drizzle/0010) whose line no operation of their
 * submission covers yet: the approval and its submission committed, and
 * admission never ran or was held (Codex #6). Recovery admits them; a
 * cancelled or cancelling submission is not resumed.
 */
export async function approvalsAwaitingAdmission(): Promise<Array<{ submissionId: string; lines: number[] }>> {
  const rows = rowsOf(
    await readQuery(sql`
      SELECT a.submission_id::text AS submission_id, to_jsonb(array_agg(a.productsorder_id ORDER BY a.productsorder_id)) AS lines
        FROM settlement_approvals a
        JOIN return_submissions s ON s.id = a.submission_id
       WHERE s.state = 'accepted'
         AND s.holder IS DISTINCT FROM 'cancellation'
         AND NOT EXISTS (SELECT 1 FROM settlement_operations o
                          WHERE o.submission_id = a.submission_id
                            AND a.productsorder_id = ANY (o.members))
       GROUP BY a.submission_id
       ORDER BY a.submission_id
    `)
  );
  return rows.map((r) => ({
    submissionId: String(r.submission_id),
    lines: ((typeof r.lines === "string" ? JSON.parse(r.lines) : r.lines) as unknown[]).map(Number),
  }));
}

/** Submissions with a done op and a line still unsettled. */
export async function submissionsToFinalize(): Promise<string[]> {
  const rows = rowsOf(
    await readQuery(sql`
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
    await readQuery(sql`
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
export async function recordReconciliationRejected(cap: WriteCapability, opId: string, evidence: string, by: string): Promise<boolean> {
  const rows = rowsOf(
    await writeDb(cap).execute(sql`
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
