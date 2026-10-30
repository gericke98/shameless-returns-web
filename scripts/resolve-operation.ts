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
 *               effect it needs is done too. What it left behind is read
 *               from Shopify and recorded exactly as the runner would:
 *                 exchange_order: pass --order <gid of the order you found>;
 *                   it must be THIS op's order (its sourceIdentifier is the
 *                   op id, its lines the frozen ones), and its real line ids
 *                   and funding are written with the done state;
 *                 release_hold: the draft must read as gone; the order's
 *                   pointer to it is cleared with the done state.
 *   --rejected  the effect did NOT happen. The operation becomes claimable
 *               again and the next settlement or recovery run re-sends it.
 *
 * Dry-run by default (Shopify is READ either way); `--write` makes ONE
 * conditional update `WHERE state = 'unresolved'`, recording who resolved it
 * and the evidence.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/resolve-operation.ts \
 *     --op <uuid> --done|--rejected --evidence "<gid / notes>" [--order <gid>] [--by <name>] [--write]
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
      order: { type: "string" },
      by: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  if (!values.op || values.done === values.rejected || !values.evidence?.trim()) {
    throw new Error(
      'usage: --op <uuid> --done|--rejected --evidence "<gid / notes>" [--order <gid>] [--by <name>] [--write]'
    );
  }
  const { getOperation } = await import("@/lib/settlement/ledger");
  const { resolveOperation } = await import("@/lib/settlement/operator");
  const op = await getOperation(values.op);
  if (!op) throw new Error(`no settlement operation ${values.op}`);
  console.log("op      :", op.id, op.kind, op.scopeKey, "state:", op.state, "attempt:", op.attempt);
  console.log("amount  :", (op.amountCents / 100).toFixed(2), op.currency, "members:", op.members.join(","));
  console.log("error   :", op.error ?? "(none)");
  const outcome = await resolveOperation(
    op,
    {
      verdict: values.done ? "done" : "rejected",
      evidence: values.evidence,
      by: values.by ?? userInfo().username,
      orderGid: values.order,
    },
    { write: values.write }
  );
  if (!outcome.ok) {
    console.log(`\nNOT changed: ${outcome.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${outcome.written ? "" : "DRY: "}${outcome.summary}${outcome.written ? "." : ". Pass --write."}`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
