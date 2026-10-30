// What each line of an exchange order WE created is worth (S2 plan L1).
//
// `replacement_lines` is written in the same transaction that marks its
// `exchange_order` op done — on every completion path, the runner's and the
// operator's (lib/settlement/ledger.ts `recordDone` refuses an exchange done
// without them). So for every exchange order created from S2 on, the funding
// of each line is explicit data keyed by Shopify's own line item id — no tag
// parsing, no variant matching.
//
// Which orders are ours is explicit too: `orderCreate` sets the order's
// `sourceIdentifier` to the exchange operation's id (lib/settlement/plan.ts),
// so an order whose source_identifier names an exchange operation IS an S2
// order, and it is valued from that operation's records or not at all. An
// order from before S2 is ours when the legacy reconciliation recorded its
// lines here (S3 R1/R4), by the order's own id.
//
// NOT "use server".
import { sql } from "drizzle-orm";
import db from "@/db/drizzle";

/** One replacement line: its EXACT total in cents and its unit count. */
export type FundedLine = { totalCents: number; quantity: number };

export type ReplacementFunding = {
  /** The order the returned garments came from. */
  sourceOrderId: string;
  /** Shopify LineItem gid → the line's exact funded total. */
  lineByLineItem: Map<string, FundedLine>;
};

export type FundingLookup =
  /** Neither an exchange operation nor the reconciliation recorded this order. */
  | { kind: "not-settlement" }
  | { kind: "funded"; funding: ReplacementFunding }
  /** Settlement created this order but its records are missing or disagree:
   *  never valued by any other means. */
  | { kind: "unfunded"; sourceOrderId: string | null; reason: string };

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/**
 * The funding of an exchange order, from `replacement_lines` and nothing else.
 *
 * Found two ways, both explicit ids:
 *  - an order created from S2 on carries the creating operation's id as its
 *    `sourceIdentifier`, and is valued from that operation's records;
 *  - an order created before S2 has its lines recorded by the legacy
 *    reconciliation (S3 R1, a `reconciled` submission), keyed by the order's
 *    own Shopify id.
 * An order with neither is not one settlement knows: `not-settlement`. Tags
 * and variant matching are never consulted (S3 R4).
 *
 * A replacement line is worth what the customer gave for it: the returned
 * garment's line value plus what they paid by card on top (`buildAgreement`
 * values a replacement as original line price + stripe_funded_cents). Kept as
 * the exact integer line total — never rounded to a unit (finding 8).
 */
export async function replacementFundingOf(order: {
  id: string;
  sourceIdentifier: string | null | undefined;
}): Promise<FundingLookup> {
  const sourceIdentifier = order.sourceIdentifier ? String(order.sourceIdentifier) : null;
  if (sourceIdentifier) {
    const [op] = rowsOf(
      await db.execute(sql`
        SELECT o.id, o.state, s.order_id AS source_order_id
          FROM settlement_operations o
          JOIN return_submissions s ON s.id = o.submission_id
         WHERE o.id::text = ${sourceIdentifier} AND o.kind = 'exchange_order'
      `)
    );
    if (op) return fundingFrom(order, [op], sql`rl.exchange_operation_id = ${op.id}`);
  }
  const ops = rowsOf(
    await db.execute(sql`
      SELECT DISTINCT o.id, o.state, s.order_id AS source_order_id
        FROM replacement_lines rl
        JOIN settlement_operations o ON o.id = rl.exchange_operation_id
        JOIN return_submissions s ON s.id = o.submission_id
       WHERE rl.order_id = ${String(order.id)}
    `)
  );
  if (ops.length === 0) return { kind: "not-settlement" };
  return fundingFrom(order, ops, sql`rl.order_id = ${String(order.id)}`);
}

async function fundingFrom(order: { id: string }, ops: any[], which: ReturnType<typeof sql>): Promise<FundingLookup> {
  const sources = new Set(ops.map((o) => String(o.source_order_id)));
  const sourceOrderId = String(ops[0].source_order_id);
  if (sources.size !== 1) {
    return { kind: "unfunded", sourceOrderId, reason: `replacement-lines-name-${sources.size}-source-orders` };
  }
  const notDone = ops.find((o) => o.state !== "done");
  if (notDone) return { kind: "unfunded", sourceOrderId, reason: `exchange-operation-${notDone.state}` };
  const rows = rowsOf(
    await db.execute(sql`
      SELECT rl.order_id, rl.line_item_id, rl.quantity, rl.stripe_funded_cents, sl.returned_cents
        FROM replacement_lines rl
        JOIN submission_lines sl
          ON sl.submission_id = rl.source_submission_id
         AND sl.productsorder_id = rl.source_productsorder_id
       WHERE ${which}
    `)
  );
  if (rows.length === 0) return { kind: "unfunded", sourceOrderId, reason: "no-replacement-lines" };
  const elsewhere = rows.find((r) => String(r.order_id) !== String(order.id));
  if (elsewhere) {
    return { kind: "unfunded", sourceOrderId, reason: `replacement-lines-name-order-${elsewhere.order_id}` };
  }
  const lineByLineItem = new Map<string, FundedLine>();
  for (const r of rows) {
    lineByLineItem.set(String(r.line_item_id), {
      totalCents: Number(r.returned_cents) + Number(r.stripe_funded_cents),
      quantity: Number(r.quantity),
    });
  }
  return { kind: "funded", funding: { sourceOrderId, lineByLineItem } };
}

/**
 * The per-unit price string a productsorder row stores for a funded line.
 *
 * Every reader values a row as `round(parseFloat(price) × quantity × 100)`
 * (lib/basket.ts `valueLine`), so the stored unit is the exact quotient,
 * unrounded: multiplying it back by the same quantity recovers the integer
 * line total (3101 cents over 2 units → "15.505" → 3101, not 1551 × 2 = 3102).
 */
export function unitPriceOf(line: FundedLine): string {
  return String(line.totalCents / line.quantity / 100);
}
