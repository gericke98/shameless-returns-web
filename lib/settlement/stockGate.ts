// Does Amphora cover a replacement? (FX §#2 D2, §#1, §#4 (d), A1.) One
// judgement over one read, at the three places a promise is made or kept:
//   - accept time (`lineCoverage` at save, `acceptCoverage` at submit) — `earlier` is ALL
//     open demand of accepted submissions;
//   - settlement (admission, and before every fresh orderCreate):
//     `exchangeCoverage` — `earlier` is the demand accepted at or before this
//     submission.
//
// Demand is the frozen replacement lines; `earlier` is the open demand of
// submissions accepted at or before this one, itself excluded — a later
// submission can never take an earlier one's unit, and equal stamps count
// both ways (no tie-breaker).
//
// NOT "use server".
import { readAvailable } from "@/lib/server/amphoraStock";
import { variantGid } from "@/lib/shopifyIds";
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
  return assess(read, lines, earlier.map(demandLine));
}

/**
 * Accept time, at submit (§#1): the customer's whole basket — the exchange
 * lines of the agreement about to be saved — against Amphora, net of every
 * open promise already accepted. The basket belongs to no accepted submission
 * yet, so it is never part of that demand.
 */
export async function acceptCoverage(basket: readonly DemandLine[]): Promise<Assessment> {
  const earlier = await openExchangeDemand();
  const read = await readAvailable(
    basket.map((l) => l.variantGid),
    earlier.map((e) => e.variantGid)
  );
  return assess(read, basket, earlier.map(demandLine));
}

/**
 * Accept time, at line save (§#1): one line, plus the order's other
 * unconfirmed exchange lines that ask for the SAME SKU (their SKUs are read
 * with it), net of every open promise already accepted. Siblings on other
 * SKUs cannot change this line's answer.
 */
export async function lineCoverage(line: DemandLine, siblings: readonly DemandLine[]): Promise<Assessment> {
  const earlier = await openExchangeDemand();
  const read = await readAvailable(
    [line.variantGid],
    [...siblings.map((l) => l.variantGid), ...earlier.map((e) => e.variantGid)]
  );
  if (!read.ok) return { kind: "unreadable", reason: read.reason };
  const skuOf = (gid: string) => read.skuOf.get(variantGid(gid) ?? "");
  const sku = skuOf(line.variantGid);
  const basket = [line, ...siblings.filter((l) => skuOf(l.variantGid) === sku)];
  return assess(read, basket, earlier.map(demandLine));
}

const demandLine = (e: { variantGid: string; quantity: number }): DemandLine => ({
  variantGid: e.variantGid,
  quantity: e.quantity,
});
