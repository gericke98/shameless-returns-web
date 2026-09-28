// One-off: link replacement orders already in the DB to their original, and
// correct the price + refund transaction on their confirmed, UNSETTLED rows.
// Dry run unless `--write`. Settled rows are reported, never touched.
//
//   npx tsx scripts/repair-replacement-order-rows.ts          # dry
//   npx tsx scripts/repair-replacement-order-rows.ts --write  # apply
import "dotenv/config";
import React from "react";
const R = React as any;
if (typeof R.cache !== "function") R.cache = (fn: any) => fn;

async function main() {
  const write = process.argv.includes("--write");
  const { default: db } = await import("@/db/drizzle");
  const { orders, productsOrder } = await import("@/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const q = await import("@/db/queries");
  const { originalOrderNumberFromTags, planReplacementPricing, resolveRootOrderId } =
    await import("@/lib/replacementOrigin");
  const { pickRefundTransaction } = await import("@/lib/refundTransaction");

  // Candidates: orders whose stored refund transaction is the placeholder.
  const candidates = await db.execute(sql`
    select distinct o.id, o.order_number from orders o
    join productsorder p on p.order_id = o.id
    where p.transaction_amount = '0.01' and o.exchange_of is null`);

  for (const c of candidates.rows as any[]) {
    const shopify = await q.getOrderQuery(String(c.order_number).replace("#", ""));
    const originalNumber = originalOrderNumberFromTags(shopify?.tags);
    if (!originalNumber) { console.log(`${c.order_number}: not tagged as a replacement — SKIP`); continue; }
    const original = await q.getOrderByNumberFresh(originalNumber);
    if (!original) { console.log(`${c.order_number}: original ${originalNumber} not in DB — SKIP`); continue; }

    const rows = await db.query.productsOrder.findMany({ where: eq(productsOrder.orderId, String(c.id)) });
    const open = rows.filter((r: any) => r.confirmed && !r.refunded);
    const settled = rows.filter((r: any) => r.confirmed && r.refunded);
    settled.forEach((r: any) => console.log(`${c.order_number}: row ${r.id} ALREADY SETTLED at ${r.price} (report only)`));

    const plan = planReplacementPricing(
      open.map((r: any) => ({ variant_id: r.variant_id, product_id: r.productId })),
      ((original as any).products ?? []) as any
    );
    const rootId = await resolveRootOrderId(String(original.id), async (id) =>
      ((await q.getOrderByIdFresh(id)) as any)?.exchangeOf ?? null);
    const tx = pickRefundTransaction(await q.getOrderTransactions(rootId));

    console.log(`${c.order_number} → original ${originalNumber} (root ${rootId}), tx ${tx?.id} ${tx?.amountSet?.shopMoney?.amount}`);
    if (open.length && !plan.ok) { console.log(`  CANNOT PRICE: ${plan.reason} — SKIP`); continue; }
    for (const r of open as any[]) {
      console.log(`  row ${r.id} ${r.title}: price ${r.price} → ${plan.ok ? plan.priceByVariant[String(r.variant_id)] : "-"}`);
    }

    if (!write) continue;
    await db.update(orders).set({ exchangeOf: String(original.id) }).where(eq(orders.id, String(c.id)));
    if (plan.ok) {
      for (const r of open as any[]) {
        await db.update(productsOrder).set({
          price: plan.priceByVariant[String(r.variant_id)],
          transaction_id: tx?.id ?? null,
          transaction_amount: tx?.amountSet?.shopMoney?.amount ?? null,
        }).where(eq(productsOrder.id, r.id));
      }
    }
    console.log(`  WRITTEN`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
