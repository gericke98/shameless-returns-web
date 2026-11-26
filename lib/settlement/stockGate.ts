// Does Amphora cover a submission's replacement at settlement? (FX §#2 D2,
// §#4 (d), A1.) One judgement, used at admission (before the exchange op is
// planned) and before every fresh orderCreate (lib/settlement/run.ts).
//
// Demand is the frozen replacement lines; `earlier` is the open demand of
// submissions accepted at or before this one, itself excluded — a later
// submission can never take an earlier one's unit, and equal stamps count
// both ways (no tie-breaker).
//
// NOT "use server".
import { readAvailable } from "@/lib/server/amphoraStock";
import { assess, type Assessment, type DemandLine } from "@/lib/stockCoverage";
import { openExchangeDemand } from "./ledger";

export async function exchangeCoverage(
  submission: { id: string; acceptedAt: Date | null },
  lines: readonly DemandLine[]
): Promise<Assessment> {
  // drizzle/0014 makes accepted_at total; a missing one is not "earliest".
  if (!submission.acceptedAt) return { kind: "unreadable", reason: "no-accepted-at" };
  const earlier = await openExchangeDemand({ submissionId: submission.id, acceptedAt: submission.acceptedAt });
  const read = await readAvailable(
    lines.map((l) => l.variantGid),
    earlier.map((e) => e.variantGid)
  );
  return assess(
    read,
    lines,
    earlier.map((e) => ({ variantGid: e.variantGid, quantity: e.quantity }))
  );
}
