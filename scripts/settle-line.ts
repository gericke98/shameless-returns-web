/**
 * Settle ONE returns-portal line by hand, through the SAME code path as the
 * dashboard button and the auto-approve cron (`lib/settleReturn.ts`).
 *
 * Why this exists: the cron pays at most AUTO_APPROVE_MAX_PER_RUN lines per
 * day, oldest order first, and two orders that fail every run sit at the front
 * of that queue. On 2026-09-21 the dry run stopped at #311903 with 17 orders
 * behind it that had never been evaluated — #311977 among them, received in
 * the warehouse five days earlier. This lets an operator settle a specific
 * line without waiting for the queue.
 *
 * MOVES MONEY / CREATES ORDERS. Read-only unless `--yes` is passed.
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/settle-line.ts <productsorder.id> [--yes]
 */
import "dotenv/config";
import React from "react";
import { eq } from "drizzle-orm";

// `db/queries.ts` wraps reads in React's `cache()`, which only exists inside a
// React render. Outside Next it is undefined and the import throws, so give it
// an identity implementation BEFORE the dynamic imports below pull it in.
const R = React as any;
if (typeof R.cache !== "function") R.cache = (fn: any) => fn;

async function main() {
  const { default: db } = await import("@/db/drizzle");
  const { productsOrder } = await import("@/db/schema");
  const { settleReturnLine } = await import("@/lib/settleReturn");
  const [rawId, flag] = process.argv.slice(2);
  if (!rawId) throw new Error("usage: settle-line.ts <productsorder.id> [--yes]");
  const lineId = Number(rawId);

  const line = await db.query.productsOrder.findFirst({
    where: eq(productsOrder.id, lineId),
  });
  if (!line) throw new Error(`no productsorder row ${lineId}`);

  const order = await db.query.orders.findFirst({
    where: (o, { eq }) => eq(o.id, String(line.orderId)),
    with: { products: { where: eq(productsOrder.confirmed, true) } },
  });
  if (!order) throw new Error(`no order ${line.orderId}`);

  console.log("order   :", order.orderNumber, order.id, order.email, "method:", order.returnMethod);
  console.log("line    :", line.id, line.title, line.variant_title, "->", line.new_variant_title ?? "(no exchange)",
    "action:", line.action, "price:", line.price, "refunded:", line.refunded, "confirmed:", line.confirmed);
  console.log("ids     :", "return:", line.return_id, "rli:", line.return_line_item_id, "tx:", line.transaction_id, "new_variant:", line.new_variant_id);

  if (line.refunded) {
    console.log("already settled — nothing to do");
    return;
  }
  if (flag !== "--yes") {
    console.log("\nDRY: pass --yes to settle this line for real.");
    return;
  }
  const outcome = await settleReturnLine(line, order);
  console.log("outcome :", JSON.stringify(outcome));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
