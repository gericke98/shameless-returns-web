// L5 — the recovery sweep. Runs every 15 minutes from
// /api/cron/settlement-recovery, gated by CRON_SECRET ONLY: the auto-approve
// gate, its cap and AUTO_APPROVE_ENABLED govern admission, never the
// execution of operations already admitted. A CLOSED Shopify return is
// expected here (returnProcess closes it), not a reason to stop.
//
// NOT "use server".
import { randomUUID } from "node:crypto";
import { enqueueOpsAlerts } from "@/actions/opsAlertOutbox";
import { admit } from "./admission";
import {
  approvalsAwaitingAdmission,
  finalize,
  hasDispatched,
  recoverableOperations,
  stuckCancellations,
  submissionsToFinalize,
} from "./ledger";
import { recoverDispatched, run, type RunResult } from "./run";

export type RecoveryReport = {
  ran: Array<{ op: string; kind: string; from: string; result: RunResult }>;
  /** Approved legacy payments whose admission never ran or was held (S3). */
  admittedApprovals: Array<{ submission: string; lines: number[]; outcome: string }>;
  finalized: Array<{ submission: string; lines: number[] }>;
  stuckCancellations: number;
  budgetExhausted: boolean;
};

export async function recoverSettlements(options: { deadline: number; limit?: number }): Promise<RecoveryReport> {
  const me = randomUUID();
  const report: RecoveryReport = {
    ran: [],
    admittedApprovals: [],
    finalized: [],
    stuckCancellations: 0,
    budgetExhausted: false,
  };

  // S3 (Codex #6): an approval recorded but never admitted — the process
  // stopped between the two, or admission was held — is admitted here. The
  // approval is the authority; admission is idempotent by scope key, so this
  // never plans a second payment. A held admission alerts once per reason.
  const heldApprovals: Array<{ submission: string; held: string }> = [];
  for (const awaiting of await approvalsAwaitingAdmission()) {
    if (Date.now() >= options.deadline) {
      report.budgetExhausted = true;
      break;
    }
    const outcome = await admit(awaiting.submissionId, awaiting.lines);
    report.admittedApprovals.push({
      submission: awaiting.submissionId,
      lines: awaiting.lines,
      outcome: outcome.ok ? "admitted" : `held:${outcome.held}`,
    });
    if (!outcome.ok) heldApprovals.push({ submission: awaiting.submissionId, held: outcome.held });
  }
  await enqueueOpsAlerts(
    heldApprovals.map((h) => ({
      dedupeKey: `approval-not-admitted:${h.submission}:${h.held}`,
      subject: `[returns] APPROVED LEGACY PAYMENT NOT ADMITTED — submission ${h.submission}`,
      body: [
        `Santi approved a legacy payment (submission ${h.submission}) and admission is held: ${h.held}.`,
        `Recovery retries it every run; nothing is paid until admission succeeds.`,
      ].join("\n"),
    }))
  );

  for (const op of await recoverableOperations(options.limit ?? 50)) {
    if (Date.now() >= options.deadline) {
      report.budgetExhausted = true;
      break;
    }
    const result =
      hasDispatched(op) ? await recoverDispatched(op, me) : await run(op.id, me);
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
