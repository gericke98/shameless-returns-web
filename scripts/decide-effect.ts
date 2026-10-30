/**
 * S3 (Codex #1, #5) — record a human's decision about ONE historical effect
 * the reconciliation could not attribute by identity: a Shopify Refund that
 * moved money and names no line (`gid://shopify/Refund/…`), or a paid pre-S1
 * Stripe Checkout Session whose metadata names no order (`cs_…`).
 *
 *   --binds <productsorder id>  the effect paid that line;
 *   --excludes                  it paid no reconciled line (e.g. a shipping
 *                               refund, a goodwill payment).
 *
 * Written once to reconciliation_effect_decisions (drizzle/0011), with who and
 * why; a second decision on the same effect is refused. The next
 * reconciliation run reads it. Dry-run by default.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/decide-effect.ts \
 *     --effect <id> (--binds <po> | --excludes) --evidence "<…>" [--by <name>] [--write]
 */
import "dotenv/config";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      effect: { type: "string" },
      binds: { type: "string" },
      excludes: { type: "boolean", default: false },
      evidence: { type: "string" },
      by: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  if (!!values.binds === values.excludes) throw new Error("exactly one of --binds <po> or --excludes");
  const { decideEffect, effectDecisionProblem } = await import("@/lib/settlement/effectDecisions");
  const decision = {
    effectId: values.effect ?? "",
    verdict: values.excludes ? ("excludes" as const) : ("binds" as const),
    productsorderId: values.binds ? Number(values.binds) : null,
    by: values.by ?? userInfo().username,
    evidence: values.evidence ?? "",
  };
  const problem = effectDecisionProblem(decision);
  if (problem) throw new Error(problem);
  console.log("decide:", JSON.stringify(decision));
  if (!values.write) {
    console.log("DRY: nothing recorded. Pass --write.");
    return;
  }
  const out = await decideEffect(decision);
  if (!out.ok) {
    console.log(`NOT recorded: ${out.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("Recorded in reconciliation_effect_decisions.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
