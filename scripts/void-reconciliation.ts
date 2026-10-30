/**
 * S3 correction (30 Oct) — void a reconciled record that R1 built on another
 * order's Shopify return (a return_id the pre-S1 confirm write stamped across
 * orders). Reads the return from Shopify (read-only) and refuses unless that
 * return's order is not the record's order, and the record has no done
 * operation. Writes the void, with who and why, in one statement
 * (lib/settlement/voidReconciliation.ts, drizzle/0012). Dry-run by default.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/void-reconciliation.ts \
 *     (--line <productsorder id> | --submission <uuid>) --evidence "<why>" [--by <name>] [--write]
 */
import "dotenv/config";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      line: { type: "string" },
      submission: { type: "string" },
      evidence: { type: "string" },
      by: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  if (!!values.line === !!values.submission) throw new Error("name the record by exactly one of --line or --submission");
  const { voidForeignReconciliation } = await import("@/lib/settlement/voidReconciliation");
  const { readReturnEvidence } = await import("@/lib/settlement/reconcileReads");
  const out = await voidForeignReconciliation(
    values.submission ? { submissionId: values.submission } : { productsorderId: Number(values.line) },
    { by: values.by ?? userInfo().username, evidence: values.evidence ?? "" },
    readReturnEvidence,
    { write: !!values.write }
  );
  if (!out.ok) {
    console.log(`NOT voided: ${out.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(out.summary);
  if (!out.written) console.log("DRY: nothing voided. Pass --write.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
