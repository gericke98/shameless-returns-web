// L5 — the recovery sweep. Runs every 15 minutes from
// /api/cron/settlement-recovery, gated by CRON_SECRET ONLY: the auto-approve
// gate, its cap and AUTO_APPROVE_ENABLED govern admission, never the
// execution of operations already admitted. A CLOSED Shopify return is
// expected here (returnProcess closes it), not a reason to stop.
//
// NOT "use server".
import { randomUUID } from "node:crypto";
import { enqueueOpsAlerts } from "@/lib/server/opsAlertOutbox";
import { admit } from "./admission";
import {
  approvalsAwaitingAdmission,
  finalize,
  hasDispatched,
  recoverableOperations,
  stuckCancellations,
  submissionsToFinalize,
  takenHoldsNotDone,
} from "./ledger";
import { recoverDispatched, runOutcome, type RunResult } from "./run";
import type { WriteCapability } from "@/lib/server/identity";

export type RecoveryReport = {
  /** `reason`: why a fresh exchange send waits (A1: Amphora unreadable). */
  ran: Array<{ op: string; kind: string; from: string; result: RunResult; reason?: string }>;
  /** Approved legacy payments whose admission never ran or was held (S3). */
  admittedApprovals: Array<{ submission: string; lines: number[]; outcome: string }>;
  finalized: Array<{ submission: string; lines: number[] }>;
  stuckCancellations: number;
  /** A2: holds an operator took to settle by hand over 24 h ago and never recorded as done. */
  takenHoldsNotDone: number;
  budgetExhausted: boolean;
};

export async function recoverSettlements(cap: WriteCapability, options: { deadline: number; limit?: number }): Promise<RecoveryReport> {
  const me = randomUUID();
  const report: RecoveryReport = {
    ran: [],
    admittedApprovals: [],
    finalized: [],
    stuckCancellations: 0,
    takenHoldsNotDone: 0,
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
    const outcome = await admit(cap, awaiting.submissionId, awaiting.lines);
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
    const outcome = hasDispatched(op)
      ? { result: await recoverDispatched(cap, op, me) }
      : await runOutcome(cap, op.id, me);
    report.ran.push({ op: op.id, kind: op.kind, from: op.state, ...outcome });
  }

  // A1 (review #6): a replacement order not sent because Amphora could not be
  // read is transient — no hold — but it must reach a human while it repeats:
  // once a day per operation, through this digest, as the taken-hold one below.
  const day = new Date().toISOString().slice(0, 10);
  const unreadable = report.ran.filter((r) => r.result === "wait");
  await enqueueOpsAlerts(
    unreadable.map((r) => ({
      dedupeKey: `exchange-stock-unreadable:${r.op}:${day}`,
      subject: `[returns] REPLACEMENT NOT SENT — Amphora stock unreadable (${r.reason})`,
      body: [
        `The replacement order of settlement operation ${r.op} was not sent: Amphora's stock could not be read (${r.reason}).`,
        `No hold was recorded (a failed read may be transient); recovery reads again every 15 minutes and sends it`,
        `as soon as Amphora covers it. This alert repeats once a day while the read keeps failing. A reason such as`,
        `no-sku, not-at-amphora, ambiguous or bad-count is not transient: fix the variant's SKU or Amphora's item.`,
      ].join("\n"),
    }))
  );

  for (const submission of await submissionsToFinalize()) {
    const lines = await finalize(cap, submission);
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
        `Check the Amphora return, the Shopify return and the Stripe refund for this order by hand,`,
        `then finish or release the cancellation.`,
      ].join("\n"),
    }))
  );

  // A2: a hold taken to settle by hand stays in this digest, once a day, until --done.
  const taken = await takenHoldsNotDone();
  report.takenHoldsNotDone = taken.length;
  await enqueueOpsAlerts(
    taken.map((h) => ({
      dedupeKey: `hold-taken-not-done:${h.id}:${day}`,
      subject: `[returns] HOLD TAKEN BY HAND, NOT DONE — submission ${h.submissionId}`,
      body: [
        `${h.takenBy} took settlement hold ${h.id} (submission ${h.submissionId}) at ${h.takenAt.toISOString()} to settle it by hand,`,
        `and it is not recorded as done. Nothing automated will ever touch this submission. Once it is settled:`,
        `  npx tsx --conditions=react-server --tsconfig tsconfig.scripts.json scripts/resolve-hold.ts --hold ${h.id} --done --evidence "<what was done>" --write`,
      ].join("\n"),
    }))
  );
  return report;
}
