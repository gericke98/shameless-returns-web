/**
 * Repair `productsorder.transaction_id` rows that name a FAILED payment.
 *
 * `createReturn` used to store `order.transactions[0]` unfiltered, so a customer
 * whose first payment attempt failed and who then paid again had the dead
 * attempt saved as the refund target. `returnRefund` against it comes back
 * "All transactions failed to be refunded" — every morning, silently, forever.
 * The selection is fixed in `lib/refundTransaction.ts`; this repairs the rows
 * written before that.
 *
 * Only rows that still owe money are touched: a settled line's transaction id
 * is history, and rewriting it would falsify what we actually refunded against.
 *
 * DRY BY DEFAULT. Pass `--apply` to write.
 *
 *   npx tsx --env-file=.env scripts/backfill-refund-transactions.ts
 *   npx tsx --env-file=.env scripts/backfill-refund-transactions.ts --apply
 */
import db from "@/db/drizzle";
import { productsOrder } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { pickRefundTransaction } from "@/lib/refundTransaction";

const APPLY = process.argv.includes("--apply");

const SHOPIFY_URL = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
const HEADERS = {
  "X-Shopify-Access-Token": process.env.NEXT_PUBLIC_ACCESS_TOKEN as string,
  "Content-Type": "application/json",
};

const TRANSACTIONS = `query($id: ID!){ order(id:$id){ name transactions(first:25){
  id kind status amountSet{ shopMoney{ amount currencyCode } } } }}`;

async function transactionsFor(orderId: string) {
  const res = await fetch(SHOPIFY_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ query: TRANSACTIONS, variables: { id: `gid://shopify/Order/${orderId}` } }),
  });
  const data: any = await res.json();
  if (!data?.data?.order) throw new Error(`no order ${orderId}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.data.order.transactions as any[];
}

async function main() {
  // Refund-lane lines only. A CAMBIO line never calls `createRefund`, so a bad
  // transaction id on one is inert — and rewriting it would be a change with no
  // behaviour behind it.
  const rows: any = await db.execute(sql`
    SELECT o.id AS order_id, o.order_number, p.id AS line_id, p.price, p.transaction_id
    FROM orders o JOIN productsorder p ON p.order_id = o.id
    WHERE p.confirmed = true
      AND (p.refunded IS NULL OR p.refunded = false)
      AND p.credit = false
      AND p.action = 'DEVOLUCIÓN'
      -- Replacement orders store the ROOT order's transaction on purpose; this
      -- script would "repair" it back to the replacement's own €0.01 sale.
      AND o.exchange_of IS NULL
      AND p.transaction_id IS NOT NULL AND p.transaction_id <> ''
    ORDER BY o.id`);
  const lines = (rows.rows ?? rows) as any[];

  let repaired = 0;
  let healthy = 0;
  const unfixable: string[] = [];

  for (const line of lines) {
    const txs = await transactionsFor(line.order_id);
    const stored = txs.find((t) => t.id === line.transaction_id);
    if (stored && String(stored.status).toUpperCase() === "SUCCESS") {
      healthy += 1;
      continue;
    }

    const correct = pickRefundTransaction(txs);
    if (!correct) {
      // Nothing on this order ever settled, so there is no card payment to
      // refund. Naming any transaction here would only move the failure.
      unfixable.push(
        `${line.order_number} (line ${line.line_id}): no successful sale on the order — needs store credit or manual handling`
      );
      continue;
    }

    const amount = correct.amountSet?.shopMoney?.amount ?? null;
    console.log(
      `${line.order_number} line ${line.line_id}: ${line.transaction_id} (${stored?.status ?? "NOT-ON-ORDER"}) -> ${correct.id} (SUCCESS ${amount})`
    );
    if (APPLY) {
      await db
        .update(productsOrder)
        .set({ transaction_id: correct.id, transaction_amount: amount })
        .where(eq(productsOrder.id, line.line_id));
    }
    repaired += 1;
  }

  console.log(
    `\n${APPLY ? "REPAIRED" : "WOULD REPAIR"} ${repaired}; already healthy ${healthy}; scanned ${lines.length}`
  );
  if (unfixable.length) {
    console.log("\nCannot be repaired automatically:");
    for (const note of unfixable) console.log(`  · ${note}`);
  }
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("backfill failed:", error);
    process.exit(1);
  });
