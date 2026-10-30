// S3 correction (30 Oct): void a reconciled record built on a FOREIGN Shopify
// return. The pre-S1 confirm write stamped one order's return_id onto rows of
// other orders sharing a variant, and R1 grouped by it. Production R1 so
// recorded #34911's return as a reconciled submission of #34700 (row 181).
//
// Explicit and audited (drizzle/0012). The record is found by its submission
// id, or by the row it covers. It is voided only when:
//   - it is a `reconciled` submission with no DONE operation (a done one
//     settled its line on that record);
//   - its operations name exactly one Shopify return (their frozen check);
//   - Shopify, read now, says that return's order is NOT the submission's.
// Then ONE statement moves the submission to `voided`, its operations to
// `void` (no claim, recovery or operator fence matches them), and writes
// reconciliation_voids with who, why, the return and its real order. Nothing
// is deleted. The row is then free: R1's next run classifies it again, and
// lib/settlement/returnOwnership makes it needs-human.
//
// Shopify is only READ. NOT "use server".
import { sql } from "drizzle-orm";
import db from "@/db/drizzle";
import type { Read, ReturnEvidence } from "./reconcile";
import { returnOwnerProblem } from "./returnOwnership";
import { reconciliationRequestOf } from "./types";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export type VoidTarget = { submissionId: string } | { productsorderId: number };
export type VoidDecision = { by: string; evidence: string };
export type VoidOutcome = { ok: true; written: boolean; summary: string } | { ok: false; reason: string };

export async function voidForeignReconciliation(
  target: VoidTarget,
  d: VoidDecision,
  readReturn: (returnGid: string) => Promise<Read<ReturnEvidence | null>>,
  options: { write: boolean }
): Promise<VoidOutcome> {
  if (!d.by.trim()) return { ok: false, reason: "who decided (--by) is required" };
  if (!d.evidence.trim()) return { ok: false, reason: "the evidence (--evidence) is required" };

  const subs = rowsOf(
    await db.execute(
      "submissionId" in target
        ? sql`SELECT s.id::text AS id, s.order_id FROM return_submissions s
               WHERE s.id::text = ${target.submissionId} AND s.state = 'reconciled'`
        : sql`SELECT DISTINCT s.id::text AS id, s.order_id FROM return_submissions s
                JOIN settlement_operations o ON o.submission_id = s.id
               WHERE s.state = 'reconciled' AND ${target.productsorderId} = ANY (o.members)`
    )
  );
  if (subs.length !== 1) return { ok: false, reason: `${subs.length} reconciled records match ${JSON.stringify(target)}` };
  const sub = subs[0];

  const ops = rowsOf(
    await db.execute(sql`SELECT id::text AS id, state, request, members FROM settlement_operations WHERE submission_id = ${sub.id}::uuid`)
  );
  if (ops.length === 0) return { ok: false, reason: `record ${sub.id} has no operations` };
  if (ops.some((o) => o.state === "done")) {
    return { ok: false, reason: `record ${sub.id} has a done operation: its line was settled on it, not voidable here` };
  }
  const returns = new Set<string>();
  for (const o of ops) {
    const req = reconciliationRequestOf(o.request);
    if (!req) return { ok: false, reason: `operation ${o.id} is not a reconciliation record` };
    returns.add(req.check.returnId);
  }
  if (returns.size !== 1) return { ok: false, reason: `record ${sub.id} names ${returns.size} Shopify returns` };
  const returnId = Array.from(returns)[0];

  const r = await readReturn(returnId);
  if (!r.ok) return { ok: false, reason: `Shopify unreadable: ${r.error}` };
  if (!r.value) return { ok: false, reason: `Shopify has no return ${returnId}` };
  const owner = r.value.order?.id ?? null;
  if (!owner) return { ok: false, reason: `return ${returnId} names no order` };
  if (!returnOwnerProblem(String(sub.order_id), owner)) {
    return { ok: false, reason: `return ${returnId} belongs to this record's order ${sub.order_id}: not foreign, not voided` };
  }

  const lines = Array.from(new Set(ops.flatMap((o) => (o.members ?? []).map(Number)))).sort((a, b) => a - b);
  const summary =
    `void record ${sub.id} of order ${sub.order_id} (lines ${lines.join(",")}): built on ${returnId}, ` +
    `which Shopify says is ${r.value.order?.name ?? ""} ${owner}; by ${d.by}`;
  if (!options.write) return { ok: true, written: false, summary: `would ${summary}` };

  const [row] = rowsOf(
    await db.execute(sql`
      WITH v AS (
        UPDATE return_submissions s SET state = 'voided'
         WHERE s.id = ${sub.id}::uuid AND s.state = 'reconciled'
           AND NOT EXISTS (SELECT 1 FROM settlement_operations o WHERE o.submission_id = s.id AND o.state = 'done')
        RETURNING s.id
      ),
      ops AS (
        UPDATE settlement_operations o SET state = 'void', updated_at = now()
          FROM v WHERE o.submission_id = v.id
        RETURNING 1
      ),
      rec AS (
        INSERT INTO reconciliation_voids (submission_id, return_id, return_order_id, voided_by, evidence)
        SELECT v.id, ${returnId}, ${owner}, ${d.by}, ${d.evidence} FROM v
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM v)::int AS voided, (SELECT count(*) FROM ops)::int AS ops,
             (SELECT count(*) FROM rec)::int AS recorded`)
  );
  return Number(row?.voided) === 1 && Number(row?.recorded) === 1 && Number(row?.ops) === ops.length
    ? { ok: true, written: true, summary }
    : { ok: false, reason: `not voided: record ${sub.id} changed meanwhile` };
}
