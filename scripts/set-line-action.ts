/**
 * S3 D3 = A — set the action of ONE confirmed line whose action is NULL.
 *
 * The reconciliation CSV (scripts/reconcile-legacy.ts) lists every such line
 * with its Shopify return, refunds and exchange orders. A human decides from
 * that and the customer's emails, and records the decision here: the action,
 * who decided and on what evidence are written in ONE statement
 * (line_action_decisions, drizzle/0009). Then the line is like any other: a
 * pending one settles through the ledger; a settled one is classified by the
 * next reconciliation run.
 *
 * Dry-run by default (prints the line); `--write` changes it.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/set-line-action.ts \
 *     --line <productsorder id> --action DEVOLUCIÓN|CAMBIO [--new-variant <id>] \
 *     --evidence "<email / Shopify facts>" [--by <name>] [--write]
 */
import "dotenv/config";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      line: { type: "string" },
      action: { type: "string" },
      "new-variant": { type: "string" },
      evidence: { type: "string" },
      by: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  const { decideLineAction, validateDecision } = await import("@/lib/settlement/lineAction");
  const decision = {
    productsorderId: Number(values.line),
    action: values.action as "DEVOLUCIÓN" | "CAMBIO",
    newVariantId: values["new-variant"] ?? null,
    by: values.by ?? userInfo().username,
    evidence: values.evidence ?? "",
  };
  const invalid = validateDecision(decision);
  if (invalid) throw new Error(`${invalid}\nusage: --line <id> --action DEVOLUCIÓN|CAMBIO [--new-variant <id>] --evidence "<…>" [--by <name>] [--write]`);

  const { default: db } = await import("@/db/drizzle");
  const { sql } = await import("drizzle-orm");
  const result: any = await db.execute(sql`
    SELECT p.id, p.order_id, o.order_number, p.title, p.variant_title, p.action, p.confirmed, p.refunded,
           p.credit, p.return_id, p.new_variant_id
      FROM productsorder p JOIN orders o ON o.id = p.order_id WHERE p.id = ${decision.productsorderId}`);
  const row = (result?.rows ?? result ?? [])[0];
  if (!row) throw new Error(`no productsorder ${decision.productsorderId}`);
  console.log("line   :", JSON.stringify(row));
  console.log("decide :", decision.action, decision.newVariantId ?? "", "by", decision.by);
  console.log("because:", decision.evidence);
  if (!values.write) {
    console.log("\nDRY: nothing changed. Pass --write.");
    return;
  }
  const out = await decideLineAction(decision);
  if (!out.ok) {
    console.log(`\nNOT changed: ${out.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nSet, and recorded in line_action_decisions.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
