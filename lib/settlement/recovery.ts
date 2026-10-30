// L5 — the recovery sweep. Runs every 15 minutes from
// /api/cron/settlement-recovery, gated by CRON_SECRET ONLY: the auto-approve
// gate, its cap and AUTO_APPROVE_ENABLED govern admission, never the
// execution of operations already admitted. A CLOSED Shopify return is
// expected here (returnProcess closes it), not a reason to stop.
//
// NOT "use server".
import { randomUUID } from "node:crypto";
import { enqueueOpsAlerts } from "@/actions/opsAlertOutbox";
import {
  finalize,
  recoverableOperations,
  stuckCancellations,
  submissionsToFinalize,
} from "./ledger";
import { recoverDispatched, run, type RunResult } from "./run";

export type RecoveryReport = {
  ran: Array<{ op: string; kind: string; from: string; result: RunResult }>;
  finalized: Array<{ submission: string; lines: number[] }>;
  stuckCancellations: number;
  budgetExhausted: boolean;
};

export async function recoverSettlements(options: { deadline: number; limit?: number }): Promise<RecoveryReport> {
  const me = randomUUID();
  const report: RecoveryReport = { ran: [], finalized: [], stuckCancellations: 0, budgetExhausted: false };

  for (const op of await recoverableOperations(options.limit ?? 50)) {
    if (Date.now() >= options.deadline) {
      report.budgetExhausted = true;
      break;
    }
    const result =
      op.state === "dispatched" ? await recoverDispatched(op, me) : await run(op.id, me);
    report.ran.push({ op: op.id, kind: op.kind, from: op.state, result });
  }

  for (const submission of await submissionsToFinalize()) {
    const lines = await finalize(submission);
    if (lines.length) report.finalized.push({ submission, lines });
  }

  const stuck = await stuckCancellations();
  report.stuckCancellations = stuck.length;
  await enqueueOpsAlerts(
    stuck.map((s) => ({
      dedupeKey: `cancellation-stuck:${s.id}`,
      subject: `[returns] CANCELLATION DID NOT FINISH — order ${s.orderId}`,
      body: [
        `A customer cancellation took submission ${s.id} (order ${s.orderId}) over an hour ago and never finished.`,
        `Settlement can never take this submission while cancellation holds it, so nothing will be paid automatically.`,
        `Check the Amphora return, the Shopify return, the stock hold and the Stripe refund for this order by hand,`,
        `then finish or release the cancellation.`,
      ].join("\n"),
    }))
  );
  return report;
}
