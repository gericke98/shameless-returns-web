// S3 (Codex #1, #5): a human's decision about ONE historical effect, by its
// stable id (reconciliation_effect_decisions, drizzle/0011) — a Shopify
// Refund gid that moved money and names no line, or a paid pre-S1 Stripe
// Checkout Session id that names no order. `binds` attributes it to one
// productsorder line; `excludes` says it paid no reconciled line. One
// decision per effect, ever: a second is refused, never overwritten.
//
// Also the ledger's own records of effects: every done operation's
// effect_ref and the lines it covered. Both feed the classifier's identity
// (lib/settlement/reconcile.ts `sharedIdentity`).
//
// NOT "use server".
import { sql } from "drizzle-orm";
import db from "@/db/drizzle";
import type { EffectDecision } from "./reconcile";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export type EffectDecisionInput = {
  effectId: string;
  verdict: "binds" | "excludes";
  productsorderId: number | null;
  by: string;
  evidence: string;
};

export function effectDecisionProblem(d: EffectDecisionInput): string | null {
  if (!d.effectId.trim()) return "the effect id is required";
  if (d.verdict !== "binds" && d.verdict !== "excludes") return "verdict must be binds or excludes";
  if (d.verdict === "binds" && !(Number.isInteger(d.productsorderId) && Number(d.productsorderId) > 0)) {
    return "binds needs the productsorder line it paid";
  }
  if (d.verdict === "excludes" && d.productsorderId !== null) return "excludes names no line";
  if (!d.by.trim()) return "who decided is required";
  if (!d.evidence.trim()) return "the evidence is required";
  return null;
}

/** Record it, once. A bound line must exist and be confirmed. */
export async function decideEffect(d: EffectDecisionInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  const problem = effectDecisionProblem(d);
  if (problem) return { ok: false, reason: problem };
  const rows = rowsOf(
    await db.execute(sql`
      INSERT INTO reconciliation_effect_decisions (effect_id, verdict, productsorder_id, decided_by, evidence)
      SELECT ${d.effectId}, ${d.verdict}, ${d.productsorderId}::int, ${d.by}, ${d.evidence}
       WHERE ${d.verdict} = 'excludes'
          OR EXISTS (SELECT 1 FROM productsorder p WHERE p.id = ${d.productsorderId}::int AND p.confirmed = true)
      ON CONFLICT (effect_id) DO NOTHING
      RETURNING effect_id
    `)
  );
  return rows.length === 1
    ? { ok: true }
    : { ok: false, reason: "already decided, or the bound line is not a confirmed productsorder line" };
}

/** Every recorded decision, by effect id. */
export async function effectDecisions(): Promise<Map<string, EffectDecision>> {
  const rows = rowsOf(
    await db.execute(sql`SELECT effect_id, verdict, productsorder_id FROM reconciliation_effect_decisions`)
  );
  return new Map(
    rows.map((r) => [
      String(r.effect_id),
      {
        verdict: r.verdict === "binds" ? ("binds" as const) : ("excludes" as const),
        productsorderId: r.productsorder_id === null ? null : Number(r.productsorder_id),
      },
    ])
  );
}

/** Effect id → the lines a DONE operation recorded it for. */
export async function recordedEffects(): Promise<Map<string, number[]>> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT o.effect_ref, m.po
        FROM settlement_operations o CROSS JOIN LATERAL unnest(o.members) AS m(po)
       WHERE o.state = 'done' AND o.effect_ref IS NOT NULL`)
  );
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const k = String(r.effect_ref);
    (out.get(k) ?? out.set(k, []).get(k)!).push(Number(r.po));
  }
  return out;
}
