/**
 * FX §#7 + A2 — resolve a settlement hold (lib/settlement/holdResolution.ts).
 * Dry-run by default; --write to apply. Every hold alert prints these lines
 * with its hold id.
 *
 *   hold a submission no hold covers yet (e.g. the customer was paid by hand):
 *     ... scripts/resolve-hold.ts --submission <id> --open --by <name> --evidence "<why>" [--write]
 *   then --take and --done that hold as below.
 *   release (re-check Amphora on the next run):
 *     npx tsx --conditions=react-server --tsconfig tsconfig.scripts.json scripts/resolve-hold.ts \
 *       --hold <id> --release --evidence "<why>" [--by <name>] [--write]
 *   settle it by hand — TAKE IT FIRST, before touching Shopify or Stripe:
 *     ... scripts/resolve-hold.ts --hold <id> --take [--by <name>] [--write]
 *     ... scripts/resolve-hold.ts --hold <id> --done --evidence "<what was done>" [--write]
 */
import "dotenv/config";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      hold: { type: "string" },
      submission: { type: "string" },
      open: { type: "boolean", default: false },
      take: { type: "boolean", default: false },
      done: { type: "boolean", default: false },
      release: { type: "boolean", default: false },
      by: { type: "string" },
      evidence: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  const verbs = (["open", "take", "done", "release"] as const).filter((v) => values[v]);
  if (verbs.length !== 1) throw new Error("name exactly one of --open, --take, --done or --release");
  const { resolveHold, openHold } = await import("@/lib/settlement/holdResolution");
  // Its write capability, minted here (F1 spec §11, G2): the operator running it.
  const { systemTarget } = await import("@/lib/server/identity");
  const job = systemTarget("resolve-hold");
  if (verbs[0] === "open") {
    if (!values.submission || values.hold) throw new Error("--open takes --submission <id> (not --hold)");
    const opened = await openHold(job, values.submission, { by: values.by ?? userInfo().username, evidence: values.evidence ?? "" }, { write: !!values.write });
    if (!opened.ok) {
      console.log(`NOT written: ${opened.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(opened.summary);
    if (!opened.written) console.log("DRY: nothing written. Pass --write.");
    return;
  }
  if (!values.hold || values.submission) throw new Error("--take/--done/--release take --hold <id> (not --submission)");
  const verb = verbs[0];
  const out = await resolveHold(
    job,
    values.hold,
    { verb, by: values.by ?? (verb === "done" ? "" : userInfo().username), evidence: values.evidence ?? "" },
    { write: !!values.write }
  );
  if (!out.ok) {
    console.log(`NOT written: ${out.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(out.summary);
  if (!out.written) console.log("DRY: nothing written. Pass --write.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
