/**
 * Resolve ONE `unresolved` settlement operation by hand (S2 plan L5).
 *
 * `unresolved` means the ledger could not prove what Shopify did — a dispatch
 * with no answer and no evidence, two candidate refunds, a gift card that does
 * not match. Nothing touches such an operation until a human looks in Shopify
 * and records what they found here:
 *
 *   --done      the effect DID happen (name it in --evidence: refund / gift
 *               card / order gid). The line is finalized if every other
 *               effect it needs is done too.
 *   --rejected  the effect did NOT happen. The operation becomes claimable
 *               again and the next settlement or admission re-sends it.
 *
 * Dry-run by default; `--write` makes ONE conditional update
 * `WHERE state = 'unresolved'`, recording who resolved it and the evidence.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/resolve-operation.ts \
 *     --op <uuid> --done|--rejected --evidence "<gid / notes>" [--by <name>] [--write]
 *
 * Moves no money itself and imports nothing that can.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { userInfo } from "node:os";

async function main() {
  const { values } = parseArgs({
    options: {
      op: { type: "string" },
      done: { type: "boolean", default: false },
      rejected: { type: "boolean", default: false },
      evidence: { type: "string" },
      by: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  if (!values.op || values.done === values.rejected || !values.evidence?.trim()) {
    throw new Error('usage: --op <uuid> --done|--rejected --evidence "<gid / notes>" [--by <name>] [--write]');
  }
  const { getOperation, recordDone, recordRejected } = await import("@/lib/settlement/ledger");
  const op = await getOperation(values.op);
  if (!op) throw new Error(`no settlement operation ${values.op}`);
  console.log("op      :", op.id, op.kind, op.scopeKey, "state:", op.state, "attempt:", op.attempt);
  console.log("amount  :", (op.amountCents / 100).toFixed(2), op.currency, "members:", op.members.join(","));
  console.log("error   :", op.error ?? "(none)");
  if (op.state !== "unresolved") {
    console.log(`\nNot unresolved (${op.state}) — nothing to resolve.`);
    return;
  }
  const by = values.by ?? userInfo().username;
  const verdict = values.done ? "done" : "rejected";
  if (!values.write) {
    console.log(`\nDRY: would mark ${verdict} by ${by} with evidence "${values.evidence}". Pass --write.`);
    return;
  }
  const fence = { state: "unresolved" as const };
  const changed = values.done
    ? (await recordDone(op, fence, values.evidence, { operator: by, evidence: values.evidence }, { resolvedBy: by })).done
    : await recordRejected(op, fence, values.evidence, by);
  console.log(changed ? `\nmarked ${verdict}.` : "\nNOT changed: the operation is no longer unresolved.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
