// L8 — settlement executes the agreement, and reports truthfully.
//
// `settleSubmission` = admit, then run each admitted operation in dependency
// order within the caller's budget, then report one status per line from the
// ledger itself — never from what this call believes it did.
//
// Entry points (L7): the dashboard (`validateReturn`, admin-gated in addition
// to this), the auto-approve cron (gated by decideAutoApprove), and recovery
// (`run` only). Nothing else reaches `send`.
//
// NOT "use server".
import { randomUUID } from "node:crypto";
import { admit } from "./admission";
import { loadSubmission, operationsOf } from "./ledger";
import { run } from "./run";
import type { LineStatus, Operation } from "./types";

export type SettleReport = {
  submissionId: string;
  /** Status of every line admitted (or asked for, when admission held). */
  lines: Array<{ productsorderId: number; status: LineStatus }>;
};

const MONEY_KINDS = new Set(["process_refund", "gift_card", "root_refund"]);

/** Ops ready to run now, dependencies first. */
function runnable(ops: Operation[]): Operation[] {
  const done = new Set(ops.filter((o) => o.state === "done").map((o) => o.id));
  const ready = (o: Operation) => !o.after || done.has(o.after);
  return ops.filter(
    (o) =>
      (o.state === "pending" || o.state === "rejected" ||
        (o.state === "claimed" && !!o.leaseUntil && o.leaseUntil.getTime() < Date.now())) &&
      ready(o)
  );
}

export function lineStatus(
  productsorderId: number,
  settledAt: Date | null,
  ops: Operation[]
): LineStatus {
  if (settledAt) return "paid";
  const mine = ops.filter((o) => o.members.includes(productsorderId));
  if (mine.length === 0) return "held:not-admitted";
  if (mine.some((o) => o.state === "unresolved")) return "unresolved";
  const rejected = mine.find((o) => o.state === "rejected");
  if (rejected) return `held:rejected:${rejected.kind}`;
  const money = mine.filter((o) => MONEY_KINDS.has(o.kind));
  if (money.every((o) => o.state === "done")) return "goods-pending";
  return "in-flight";
}

export async function settleSubmission(
  submissionId: string,
  productsorderIds: readonly number[],
  options: { deadline?: number; me?: string } = {}
): Promise<SettleReport> {
  const me = options.me ?? randomUUID();
  const admitted = await admit(submissionId, productsorderIds);
  if (!admitted.ok) {
    return {
      submissionId,
      lines: productsorderIds.map((id) => ({ productsorderId: id, status: `held:${admitted.held}` as LineStatus })),
    };
  }

  // Dependencies first: an op whose `after` just finished becomes runnable on
  // the next pass. Bounded by the op count, so a refusal cannot loop.
  const tried = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    const ops = await operationsOf(submissionId);
    const next = runnable(ops).filter((o) => !tried.has(o.id));
    if (next.length === 0) break;
    for (const op of next) {
      if (options.deadline && Date.now() >= options.deadline) break;
      tried.add(op.id);
      await run(op.id, me);
    }
  }

  const loaded = await loadSubmission(submissionId);
  const ops = await operationsOf(submissionId);
  const settled = new Map((loaded?.lines ?? []).map((l) => [l.productsorderId, l.settledAt]));
  return {
    submissionId,
    lines: admitted.admitted.map((id) => ({
      productsorderId: id,
      status: lineStatus(id, settled.get(id) ?? null, ops),
    })),
  };
}
