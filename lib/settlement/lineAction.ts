// S3 D3 = A: a human sets the action of a confirmed line whose action is NULL
// (scripts/set-line-action.ts), from the customer's emails or Shopify. The
// change and the record of who decided it, on what evidence, are ONE
// statement (drizzle/0009 `line_action_decisions`), so no action is ever set
// without its reason. Once set, the line is like any other: a pending one is
// settled through the ledger, a settled one goes through the reconciliation.
//
// Refused for a line that already has an action, or that any submission or
// settlement operation already covers — what was agreed or recorded is never
// rewritten underneath it.
//
// NOT "use server". Moves no money.
import { sql } from "drizzle-orm";
import db from "@/db/drizzle";
import { variantGid } from "@/lib/shopifyIds";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export type LineActionDecision = {
  productsorderId: number;
  action: "DEVOLUCIÓN" | "CAMBIO";
  /** CAMBIO only: the variant the customer gets (bare id or gid). */
  newVariantId: string | null;
  by: string;
  evidence: string;
};

export function validateDecision(d: LineActionDecision): string | null {
  if (!Number.isInteger(d.productsorderId) || d.productsorderId <= 0) return "not a productsorder id";
  if (d.action !== "DEVOLUCIÓN" && d.action !== "CAMBIO") return "action must be DEVOLUCIÓN or CAMBIO";
  if (d.action === "CAMBIO" && !variantGid(d.newVariantId)) return "CAMBIO needs --new-variant";
  if (d.action === "DEVOLUCIÓN" && d.newVariantId) return "DEVOLUCIÓN takes no --new-variant";
  if (!d.by.trim()) return "who decided (--by) is required";
  if (!d.evidence.trim()) return "the evidence (--evidence) is required";
  return null;
}

export async function decideLineAction(d: LineActionDecision): Promise<{ ok: true } | { ok: false; reason: string }> {
  const invalid = validateDecision(d);
  if (invalid) return { ok: false, reason: invalid };
  const newVariant = d.action === "CAMBIO" ? variantGid(d.newVariantId) : null;
  const rows = rowsOf(
    await db.execute(sql`
      WITH d AS (
        UPDATE productsorder p
           SET action = ${d.action},
               new_variant_id = COALESCE(${newVariant}, p.new_variant_id)
         WHERE p.id = ${d.productsorderId}
           AND p.action IS NULL
           AND p.confirmed = true
           -- A line with no Shopify return is the reconciliation's
           -- needs-human: no decision recorded here may touch it.
           AND p.return_id IS NOT NULL
           AND p.return_line_item_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM submission_lines sl
                            JOIN return_submissions s ON s.id = sl.submission_id
                           WHERE sl.productsorder_id = p.id AND s.state IN ('accepted', 'reconciled'))
           AND NOT EXISTS (SELECT 1 FROM settlement_operations o WHERE p.id = ANY (o.members))
        RETURNING p.id
      ),
      ins AS (
        INSERT INTO line_action_decisions (productsorder_id, action, new_variant_id, decided_by, evidence)
        SELECT d.id, ${d.action}, ${newVariant}, ${d.by}, ${d.evidence} FROM d
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM d)::int AS changed, (SELECT count(*) FROM ins)::int AS recorded
    `)
  );
  const changed = Number(rows[0]?.changed ?? 0);
  return changed === 1
    ? { ok: true }
    : { ok: false, reason: "not a confirmed NULL-action line on a Shopify return, free of any submission or operation" };
}
