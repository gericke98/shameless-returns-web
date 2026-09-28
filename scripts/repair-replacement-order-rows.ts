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

  const fixed: string[] = [];
  const wouldFix: string[] = [];
  const skipped: { orderNumber: string; reason: string }[] = [];
  const failed: { orderNumber: string; error: unknown }[] = [];

  for (const c of candidates.rows as any[]) {
    const orderNumber = String(c.order_number);
    // Every candidate is isolated: a throw anywhere below (a Shopify fetch
    // failure, the exchange_of cycle throw in resolveRootOrderId, an
    // unexpected shape) must not abort the run for every OTHER candidate — it
    // gets recorded as failed and the loop moves on.
    try {
      const shopify = await q.getOrderQuery(orderNumber.replace("#", ""));
      const originalNumber = originalOrderNumberFromTags(shopify?.tags);
      if (!originalNumber) {
        console.log(`${orderNumber}: not tagged as a replacement — SKIP`);
        skipped.push({ orderNumber, reason: "not tagged as a replacement" });
        continue;
      }
      const original = await q.getOrderByNumberFresh(originalNumber);
      if (!original) {
        console.log(`${orderNumber}: original ${originalNumber} not in DB — SKIP`);
        skipped.push({ orderNumber, reason: `original ${originalNumber} not in DB` });
        continue;
      }

      const rows = await db.query.productsOrder.findMany({ where: eq(productsOrder.orderId, String(c.id)) });
      const open = rows.filter((r: any) => r.confirmed && !r.refunded);
      const settled = rows.filter((r: any) => r.confirmed && r.refunded);
      settled.forEach((r: any) => console.log(`${orderNumber}: row ${r.id} ALREADY SETTLED at ${r.price} (report only)`));

      const plan = planReplacementPricing(
        open.map((r: any) => ({ variant_id: r.variant_id, product_id: r.productId })),
        ((original as any).products ?? []) as any
      );
      const rootId = await resolveRootOrderId(String(original.id), async (id) =>
        ((await q.getOrderByIdFresh(id)) as any)?.exchangeOf ?? null);
      const tx = pickRefundTransaction(await q.getOrderTransactions(rootId));

      console.log(`${orderNumber} → original ${originalNumber} (root ${rootId}), tx ${tx?.id} ${tx?.amountSet?.shopMoney?.amount}`);
      if (open.length && !plan.ok) {
        console.log(`  CANNOT PRICE: ${plan.reason} — SKIP`);
        skipped.push({ orderNumber, reason: `cannot price: ${plan.reason}` });
        continue;
      }
      for (const r of open as any[]) {
        console.log(`  row ${r.id} ${r.title}: price ${r.price} → ${plan.ok ? plan.priceByVariant[String(r.variant_id)] : "-"}`);
      }

      if (!write) {
        wouldFix.push(orderNumber);
        continue;
      }

      // Row corrections happen BEFORE the order is linked. `exchange_of` is
      // the "done" flag that removes this order from the candidate SQL above
      // (its WHERE clause requires `exchange_of is null`), so writing it
      // first and then failing partway through the row updates would strand
      // the order permanently: every future run of this script would see it
      // as already handled and skip it silently, with its still-wrong
      // price/transaction_id/transaction_amount now invisible to the one
      // tool built to fix them. Writing the rows first means a crash here
      // simply leaves the order eligible to be picked up again next run.
      if (plan.ok) {
        for (const r of open as any[]) {
          await db.update(productsOrder).set({
            price: plan.priceByVariant[String(r.variant_id)],
            transaction_id: tx?.id ?? null,
            transaction_amount: tx?.amountSet?.shopMoney?.amount ?? null,
          }).where(eq(productsOrder.id, r.id));
        }
      }
      await db.update(orders).set({ exchangeOf: String(original.id) }).where(eq(orders.id, String(c.id)));
      console.log(`  WRITTEN`);
      fixed.push(orderNumber);
    } catch (e) {
      console.error(`${orderNumber}: FAILED —`, e);
      failed.push({ orderNumber, error: e });
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`fixed (${fixed.length}): ${fixed.join(", ") || "-"}`);
  console.log(`would-fix, dry run (${wouldFix.length}): ${wouldFix.join(", ") || "-"}`);
  console.log(
    `skipped (${skipped.length}): ${
      skipped.map((s) => `${s.orderNumber} [${s.reason}]`).join(", ") || "-"
    }`
  );
  console.log(`failed (${failed.length}): ${failed.map((f) => f.orderNumber).join(", ") || "-"}`);

  return { failed };
}
main()
  .then(({ failed }) => process.exit(failed.length ? 1 : 0))
  .catch((e) => { console.error(e); process.exit(1); });
