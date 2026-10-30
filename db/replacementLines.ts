// What each line of an exchange order WE created is worth (S2 plan L1).
//
// `replacement_lines` is written from the `orderCreate` response in the same
// transaction that marks the exchange operation done, so for every exchange
// order created from S2 on, the funding of each line is explicit data keyed by
// Shopify's own line item id — no tag parsing, no variant matching.
//
// NOT "use server".
import { sql } from "drizzle-orm";
import db from "@/db/drizzle";

export type ReplacementFunding = {
  /** The order the returned garments came from. */
  sourceOrderId: string;
  /** Shopify LineItem gid → value of ONE unit, in cents. */
  unitCentsByLineItem: Map<string, number>;
};

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

/**
 * The funding of an exchange order created by settlement, or null when this
 * order was not created by settlement (every order before S2).
 *
 * A replacement line is worth what the customer gave for it: the returned
 * garment's value plus what they paid by card on top (`buildAgreement` values
 * a replacement as original line price + stripe_funded_cents).
 */
export async function replacementFundingOf(orderId: string): Promise<ReplacementFunding | null> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT rl.line_item_id, rl.quantity, rl.stripe_funded_cents, sl.returned_cents,
             s.order_id AS source_order_id
        FROM replacement_lines rl
        JOIN submission_lines sl
          ON sl.submission_id = rl.source_submission_id
         AND sl.productsorder_id = rl.source_productsorder_id
        JOIN return_submissions s ON s.id = rl.source_submission_id
       WHERE rl.order_id = ${orderId}
    `)
  );
  if (rows.length === 0) return null;
  const sources = new Set(rows.map((r) => String(r.source_order_id)));
  if (sources.size !== 1) {
    throw new Error(`replacement order ${orderId} draws on ${sources.size} source orders`);
  }
  const unitCentsByLineItem = new Map<string, number>();
  for (const r of rows) {
    const quantity = Number(r.quantity);
    const total = Number(r.returned_cents) + Number(r.stripe_funded_cents);
    unitCentsByLineItem.set(String(r.line_item_id), Math.round(total / quantity));
  }
  return { sourceOrderId: Array.from(sources)[0], unitCentsByLineItem };
}
