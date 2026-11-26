/**
 * FX §#8 (deploy step P3) — release the stock-hold drafts placed before FX,
 * from each order's persisted pointer (lib/settlement/holdRelease.ts). Reads
 * every draft from Shopify; with --write deletes the open ones, reads each
 * back, records every outcome (hold_draft_releases) and clears the pointer of
 * a draft that is gone. A completed draft is never deleted. Dry-run by
 * default. Prints every draft's outcome and the pointers left.
 *
 *   npx tsx --conditions=react-server --tsconfig tsconfig.scripts.json scripts/release-hold-drafts.ts [--by <name>] [--write]
 */
import "dotenv/config";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      by: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  const { releaseHoldDraftsForMigration } = await import("@/lib/settlement/holdRelease");
  // Its write capability, minted here (F1 spec §11, G2): the operator running it.
  const { systemTarget } = await import("@/lib/server/identity");
  const job = systemTarget("release-hold-drafts");
  const out = await releaseHoldDraftsForMigration(job, { write: !!values.write, by: values.by ?? userInfo().username });
  for (const r of out.releases) {
    console.log(
      `order ${r.orderId}  draft ${r.draftOrderId}  ${r.outcome}${r.pointerCleared ? "  (pointer cleared)" : ""}` +
        (Object.keys(r.detail).length ? `  ${JSON.stringify(r.detail)}` : "")
    );
  }
  console.log(`${out.releases.length} draft(s) read; ${out.remainingPointers} pointer(s) remain.`);
  if (!values.write) console.log("DRY: nothing deleted or recorded. Pass --write.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
