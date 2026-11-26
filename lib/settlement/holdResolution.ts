// FX §#7 + A2 — an operator resolves a settlement hold. Three verbs, each ONE
// statement on the submission's admission fence (`admission_seq` CAS), so two
// resolutions, or a resolution and an admission, can never both win:
//
//   take    — "I will settle this by hand." BEFORE touching Shopify or Stripe.
//             The submission's holder becomes 'manual' (the ledger's single
//             owner: cancellation, admission, claim and A1 all refuse it) and
//             every not-done operation of it is voided. Refused while any op is
//             in flight (claimed, dispatched, unresolved).
//   done    — "I settled it." Only on a hold taken (holder 'manual'): the hold
//             closes as `manual`, the submission's rows are marked `refunded`.
//             The holder stays 'manual' forever.
//   open    — "Stop it before it settles." An operator holds an accepted
//             submission that no hold covers yet (cause 'operator'): the case
//             where the customer was paid by hand outside the ledger, so
//             nothing automated may settle it again. Then take / done as usual.
//             Refused while any op is in flight, or a hold already blocks it.
//   release — "Try again." Only on an untaken hold, holder NULL or settlement:
//             the hold closes as `release`; the next admission, claim or A1
//             reads Amphora afresh (and may hold it again, with a new id).
//
// Counts are compared after the write, the way voidForeignReconciliation does.
// Each verb first locks the submission row (F1 §10 pattern), as dispatch does.
// NOT "use server".
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { readQuery, writeDb } from "@/db/drizzle";
import type { WriteCapability } from "@/lib/server/identity";
import { getHold, holdAlert, holdAlertColumns, type Hold } from "./ledger";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export type HoldVerb = "take" | "done" | "release";
export type HoldDecision = { verb: HoldVerb; by: string; evidence: string };
export type HoldOutcome = { ok: true; written: boolean; summary: string } | { ok: false; reason: string };

type SubmissionNow = { state: string; holder: string | null; seq: number; inFlight: number; notDone: number };

async function submissionNow(id: string): Promise<SubmissionNow | null> {
  const [row] = rowsOf(
    await readQuery(sql`
      SELECT s.state, s.holder, s.admission_seq,
             (SELECT count(*) FROM settlement_operations o
               WHERE o.submission_id = s.id AND o.state IN ('claimed', 'dispatched', 'unresolved'))::int AS in_flight,
             (SELECT count(*) FROM settlement_operations o
               WHERE o.submission_id = s.id AND o.state NOT IN ('done', 'void'))::int AS not_done
        FROM return_submissions s WHERE s.id = ${id}
    `)
  );
  return row
    ? { state: row.state, holder: row.holder ?? null, seq: Number(row.admission_seq), inFlight: Number(row.in_flight), notDone: Number(row.not_done) }
    : null;
}

/** Why this verb cannot apply to this hold now — or null. Re-checked by the write itself. */
function refusal(verb: HoldVerb, hold: Hold, s: SubmissionNow): string | null {
  if (hold.resolvedAt) return `hold ${hold.id} is already resolved (${hold.resolution})`;
  if (verb === "take") {
    if (hold.takenAt) return `hold ${hold.id} is already taken by ${hold.takenBy}`;
    if (s.state !== "accepted") return `the submission is ${s.state}, not accepted`;
    if (s.holder !== null && s.holder !== "settlement") return `the submission is held by ${s.holder}`;
    if (s.inFlight > 0) return `${s.inFlight} operation(s) are in flight (claimed, dispatched or unresolved): resolve them first`;
    return null;
  }
  if (verb === "done") {
    if (!hold.takenAt) return `hold ${hold.id} was never taken: --take it BEFORE settling by hand`;
    if (s.holder !== "manual") return `the submission is not held by hand (holder ${s.holder})`;
    return null;
  }
  if (hold.takenAt) return `hold ${hold.id} was taken by ${hold.takenBy}: finish it with --done`;
  if (s.holder !== null && s.holder !== "settlement") return `the submission is held by ${s.holder}`;
  return null;
}

export async function resolveHold(
  cap: WriteCapability,
  holdId: string,
  d: HoldDecision,
  options: { write: boolean }
): Promise<HoldOutcome> {
  if (d.verb !== "done" && !d.by.trim()) return { ok: false, reason: "who (--by) is required" };
  if (d.verb !== "take" && !d.evidence.trim()) return { ok: false, reason: "the evidence (--evidence) is required" };
  const hold = await getHold(holdId);
  if (!hold) return { ok: false, reason: `no hold ${holdId}` };
  const s = await submissionNow(hold.submissionId);
  if (!s) return { ok: false, reason: `no submission ${hold.submissionId}` };
  const why = refusal(d.verb, hold, s);
  if (why) return { ok: false, reason: why };

  const summary =
    d.verb === "take"
      ? `take hold ${hold.id} (${hold.cause}) of submission ${hold.submissionId} by hand for ${d.by}; void ${s.notDone} operation(s)`
      : d.verb === "done"
        ? `record hold ${hold.id} (${hold.cause}) of submission ${hold.submissionId} as settled by hand (${hold.takenBy}): ${d.evidence}`
        : `release hold ${hold.id} (${hold.cause}) of submission ${hold.submissionId} by ${d.by}: ${d.evidence}`;
  if (!options.write) return { ok: true, written: false, summary: `would ${summary}` };

  const statement =
    d.verb === "take"
      ? sql`
        WITH s AS (
          UPDATE return_submissions rs
             SET admission_seq = rs.admission_seq + 1, holder = 'manual', holder_since = now()
           WHERE rs.id = ${hold.submissionId} AND rs.admission_seq = ${s.seq}
             AND rs.state = 'accepted'
             AND (rs.holder IS NULL
                  OR (rs.holder = 'settlement'
                      AND NOT EXISTS (SELECT 1 FROM settlement_operations o
                                       WHERE o.submission_id = rs.id
                                         AND o.state IN ('claimed', 'dispatched', 'unresolved'))))
             AND EXISTS (SELECT 1 FROM settlement_holds h
                          WHERE h.id = ${hold.id} AND h.submission_id = rs.id
                            AND h.resolved_at IS NULL AND h.taken_at IS NULL)
          RETURNING rs.id
        ),
        h AS (
          UPDATE settlement_holds h SET taken_by = ${d.by}, taken_at = now()
            FROM s WHERE h.id = ${hold.id} AND h.submission_id = s.id
          RETURNING h.id
        ),
        ops AS (
          UPDATE settlement_operations o SET state = 'void', updated_at = now()
            FROM s WHERE o.submission_id = s.id AND o.state NOT IN ('done', 'void')
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM s)::int AS s, (SELECT count(*) FROM h)::int AS h, (SELECT count(*) FROM ops)::int AS ops`
      : d.verb === "done"
        ? sql`
        WITH s AS (
          UPDATE return_submissions rs SET admission_seq = rs.admission_seq + 1
           WHERE rs.id = ${hold.submissionId} AND rs.admission_seq = ${s.seq} AND rs.holder = 'manual'
             AND EXISTS (SELECT 1 FROM settlement_holds h
                          WHERE h.id = ${hold.id} AND h.submission_id = rs.id
                            AND h.resolved_at IS NULL AND h.taken_at IS NOT NULL)
          RETURNING rs.id
        ),
        h AS (
          UPDATE settlement_holds h
             SET resolution = 'manual', resolved_by = COALESCE(NULLIF(btrim(${d.by}), ''), h.taken_by),
                 evidence = ${d.evidence}, resolved_at = now()
            FROM s WHERE h.id = ${hold.id} AND h.submission_id = s.id
          RETURNING h.id
        ),
        p AS (
          UPDATE productsorder p SET refunded = true
            FROM s
           WHERE p.id IN (SELECT sl.productsorder_id FROM submission_lines sl WHERE sl.submission_id = s.id)
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM s)::int AS s, (SELECT count(*) FROM h)::int AS h, (SELECT count(*) FROM p)::int AS rows`
        : sql`
        WITH s AS (
          UPDATE return_submissions rs SET admission_seq = rs.admission_seq + 1
           WHERE rs.id = ${hold.submissionId} AND rs.admission_seq = ${s.seq}
             AND (rs.holder IS NULL OR rs.holder = 'settlement')
             AND EXISTS (SELECT 1 FROM settlement_holds h
                          WHERE h.id = ${hold.id} AND h.submission_id = rs.id
                            AND h.resolved_at IS NULL AND h.taken_at IS NULL)
          RETURNING rs.id
        ),
        h AS (
          UPDATE settlement_holds h
             SET resolution = 'release', resolved_by = ${d.by}, evidence = ${d.evidence}, resolved_at = now()
            FROM s WHERE h.id = ${hold.id} AND h.submission_id = s.id
          RETURNING h.id
        )
        SELECT (SELECT count(*) FROM s)::int AS s, (SELECT count(*) FROM h)::int AS h`;

  // The submission and the hold move together or not at all (one statement);
  // what was voided or marked is reported as the write counted it. It runs
  // after (1) locks the submission row — dispatch's lock (review #2) — so its
  // in-flight check reads a fresh snapshot: a claim that a dispatch turned
  // into a send while this waited is seen, never voided as if unsent.
  const [, rows] = await writeDb(cap).transact([
    sql`SELECT id FROM return_submissions WHERE id = ${hold.submissionId} FOR UPDATE`,
    statement,
  ]);
  const [row] = rows ?? [];
  if (Number(row?.s) !== 1 || Number(row?.h) !== 1) {
    return { ok: false, reason: `not written: submission ${hold.submissionId} or hold ${hold.id} changed meanwhile` };
  }
  const counted =
    d.verb === "take" ? ` — ${Number(row.ops)} operation(s) voided` : d.verb === "done" ? ` — ${Number(row.rows)} row(s) marked refunded` : "";
  return { ok: true, written: true, summary: `${summary}${counted}` };
}

export type OpenOutcome = { ok: true; written: boolean; summary: string; holdId?: string } | { ok: false; reason: string };

/**
 * `open`: an operator holds an accepted submission no hold covers yet. ONE
 * statement on the admission fence, exactly like insertHold: the submission
 * CAS (accepted, holder NULL or settlement, nothing in flight, no blocking
 * hold), the hold row, its outbox alert. After it, admission, claim and A1
 * all refuse the submission; --take / --done finish it.
 */
export async function openHold(
  cap: WriteCapability,
  submissionId: string,
  d: { by: string; evidence: string },
  options: { write: boolean }
): Promise<OpenOutcome> {
  if (!d.by.trim()) return { ok: false, reason: "who (--by) is required" };
  if (!d.evidence.trim()) return { ok: false, reason: "why (--evidence) is required" };
  const s = await submissionNow(submissionId);
  if (!s) return { ok: false, reason: `no submission ${submissionId}` };
  if (s.state !== "accepted") return { ok: false, reason: `the submission is ${s.state}, not accepted` };
  if (s.holder !== null && s.holder !== "settlement") return { ok: false, reason: `the submission is held by ${s.holder}` };
  if (s.inFlight > 0) {
    return { ok: false, reason: `${s.inFlight} operation(s) are in flight (claimed, dispatched or unresolved): resolve them first` };
  }
  const [blocking] = rowsOf(
    await readQuery(sql`
      SELECT id, resolution FROM settlement_holds
       WHERE submission_id = ${submissionId} AND (resolved_at IS NULL OR resolution = 'manual')
       LIMIT 1`)
  );
  if (blocking) {
    return { ok: false, reason: `hold ${blocking.id} already blocks this submission${blocking.resolution ? ` (${blocking.resolution})` : ""}: use it` };
  }

  const holdId = randomUUID();
  const summary = `open an operator hold on submission ${submissionId} for ${d.by}: ${d.evidence}`;
  if (!options.write) return { ok: true, written: false, summary: `would ${summary}` };

  const alert = holdAlert(holdId, submissionId, "operator", [`Opened by ${d.by}: ${d.evidence}`]);
  const [, rows] = await writeDb(cap).transact([
    sql`SELECT id FROM return_submissions WHERE id = ${submissionId} FOR UPDATE`,
    sql`
      WITH s AS (
        UPDATE return_submissions rs
           SET admission_seq = rs.admission_seq + 1
         WHERE rs.id = ${submissionId} AND rs.admission_seq = ${s.seq}
           AND rs.state = 'accepted'
           AND (rs.holder IS NULL OR rs.holder = 'settlement')
           AND NOT EXISTS (SELECT 1 FROM settlement_operations o
                            WHERE o.submission_id = rs.id AND o.state IN ('claimed', 'dispatched', 'unresolved'))
           AND NOT EXISTS (SELECT 1 FROM settlement_holds bh
                            WHERE bh.submission_id = rs.id AND (bh.resolved_at IS NULL OR bh.resolution = 'manual'))
        RETURNING rs.id
      ),
      h AS (
        INSERT INTO settlement_holds (id, submission_id, cause, detail)
        SELECT ${holdId}, s.id, 'operator', ${JSON.stringify({ openedBy: d.by, why: d.evidence })}::jsonb FROM s
        RETURNING id, submission_id
      ),
      a AS (
        INSERT INTO ops_alerts (dedupe_key, subject, body)
        SELECT ${holdAlertColumns(alert, sql`h.submission_id`)} FROM h
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM s)::int AS s, (SELECT count(*) FROM h)::int AS h`,
  ]);
  const [row] = rows ?? [];
  if (Number(row?.s) !== 1 || Number(row?.h) !== 1) {
    return { ok: false, reason: `not written: submission ${submissionId} changed meanwhile` };
  }
  return { ok: true, written: true, summary: `${summary} — hold ${holdId}`, holdId };
}
