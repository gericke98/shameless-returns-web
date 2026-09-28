// One-off: link replacement orders already in the DB to their original, and
// correct the prices that settlement reads through that link.
// Dry run unless `--write`.
//
// Per candidate (a replacement whose rows still carry the €0.01 placeholder):
//   - confirmed UNSETTLED rows: price + refund transaction (the root's).
//   - confirmed CAMBIO rows, SETTLED OR NOT: price. A settled one gets price
//     ONLY — its transaction fields are history. It matters because a
//     replacement whose customer exchanged AGAIN produced a second replacement
//     (tagged `Order #<this one>`), and that one is priced from THESE CAMBIO
//     rows; left at list, the root walk would overpay against the real payment.
//   - any row that must be priced and cannot be → the whole candidate is
//     SKIPPED: no row written, no link.
//   - other settled rows are reported, never touched.
// A candidate whose original is itself an unrepaired candidate waits for it
// (processed in later passes), so a chain is always priced from corrected rows.
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
  const found = await db.execute(sql`
    select distinct o.id, o.order_number from orders o
    join productsorder p on p.order_id = o.id
    where p.transaction_amount = '0.01' and o.exchange_of is null`);
  const candidates = (found.rows as any[]).map((c) => ({
    id: String(c.id),
    orderNumber: String(c.order_number),
  }));
  const candidateIds = new Set(candidates.map((c) => c.id));

  // What this run has corrected (or, dry, WOULD correct), so a chained
  // replacement is planned against its original's corrected state: row id →
  // price, and order id → the original it gets linked to.
  const priceOverlay = new Map<string, string>();
  const linkOverlay = new Map<string, string>();
  const done = new Set<string>();

  const fixed: string[] = [];
  const linkOnly: string[] = [];
  const wouldFix: string[] = [];
  const wouldLinkOnly: string[] = [];
  const skipped: { orderNumber: string; reason: string }[] = [];
  const failed: { orderNumber: string; error: unknown }[] = [];

  const isCambio = (r: any) => r.action === "CAMBIO";

  // "deferred": its original is a candidate this run has not finished yet.
  async function repair(c: { id: string; orderNumber: string }): Promise<"deferred" | void> {
    const { orderNumber } = c;
    const shopify = await q.getOrderQuery(orderNumber.replace("#", ""));
    const originalNumber = originalOrderNumberFromTags(shopify?.tags);
    if (!originalNumber) {
      console.log(`${orderNumber}: not tagged as a replacement — SKIP`);
      skipped.push({ orderNumber, reason: "not tagged as a replacement" });
      return;
    }
    const original = await q.getOrderByNumberFresh(originalNumber);
    if (!original) {
      console.log(`${orderNumber}: original ${originalNumber} not in DB — SKIP`);
      skipped.push({ orderNumber, reason: `original ${originalNumber} not in DB` });
      return;
    }
    const originalId = String(original.id);
    if (candidateIds.has(originalId) && !done.has(originalId)) return "deferred";

    const rows = await db.query.productsOrder.findMany({ where: eq(productsOrder.orderId, c.id) });
    // Rows that must carry the paid price: every open row, and every CAMBIO
    // row whether settled or not.
    const toPrice = rows.filter((r: any) => r.confirmed && (!r.refunded || isCambio(r)));
    rows
      .filter((r: any) => r.confirmed && r.refunded && !isCambio(r))
      .forEach((r: any) => console.log(`${orderNumber}: row ${r.id} ALREADY SETTLED at ${r.price} (report only)`));

    const originalRows = (((original as any).products ?? []) as any[]).map((r: any) =>
      priceOverlay.has(String(r.id)) ? { ...r, price: priceOverlay.get(String(r.id)) } : r
    );
    const plan = toPrice.length
      ? planReplacementPricing(
          toPrice.map((r: any) => ({ variant_id: r.variant_id, product_id: r.productId })),
          originalRows as any
        )
      : null;
    const rootId = await resolveRootOrderId(originalId, async (id) =>
      linkOverlay.get(id) ?? (((await q.getOrderByIdFresh(id)) as any)?.exchangeOf ?? null));
    const tx = pickRefundTransaction(await q.getOrderTransactions(rootId));
    const txLabel = tx
      ? `tx ${tx.id} ${tx.amountSet?.shopMoney?.amount}`
      : "NO REFUND TRANSACTION";
    const isLinkOnly = toPrice.length === 0;

    console.log(
      `${orderNumber} → original ${originalNumber} (root ${rootId}), ${txLabel}${isLinkOnly ? " — link only (no rows to correct)" : ""}`
    );
    if (plan && !plan.ok) {
      console.log(`  CANNOT PRICE: ${plan.reason} — SKIP (no rows written, not linked)`);
      skipped.push({ orderNumber, reason: `cannot price: ${plan.reason}` });
      return;
    }
    const priceOf = (r: any) => (plan && plan.ok ? plan.priceByVariant[String(r.variant_id)] : undefined) as string;
    const settledCambio = (r: any) => !!r.refunded && isCambio(r);
    for (const r of toPrice as any[]) {
      console.log(
        `  row ${r.id} ${r.title} [${r.action}]: price ${r.price} → ${priceOf(r)}${settledCambio(r) ? " (settled, price only)" : ""}`
      );
      priceOverlay.set(String(r.id), priceOf(r));
    }
    linkOverlay.set(c.id, originalId);

    if (!write) {
      (isLinkOnly ? wouldLinkOnly : wouldFix).push(orderNumber);
      done.add(c.id);
      return;
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
    for (const r of toPrice as any[]) {
      await db
        .update(productsOrder)
        .set(
          settledCambio(r)
            ? { price: priceOf(r) }
            : {
                price: priceOf(r),
                transaction_id: tx?.id ?? null,
                transaction_amount: tx?.amountSet?.shopMoney?.amount ?? null,
              }
        )
        .where(eq(productsOrder.id, r.id));
    }
    await db.update(orders).set({ exchangeOf: originalId }).where(eq(orders.id, c.id));
    console.log(isLinkOnly ? `  WRITTEN (link only)` : `  WRITTEN (${toPrice.length} row(s) + link)`);
    (isLinkOnly ? linkOnly : fixed).push(orderNumber);
    done.add(c.id);
  }

  // Passes: a candidate waiting on its original is retried after the pass
  // that handled the original. A pass with no progress ends the run.
  let pending = candidates;
  while (pending.length) {
    const deferred: typeof candidates = [];
    for (const c of pending) {
      // Every candidate is isolated: a throw anywhere (a Shopify fetch
      // failure, the exchange_of cycle throw in resolveRootOrderId, an
      // unexpected shape) must not abort the run for every OTHER candidate —
      // it gets recorded as failed and the loop moves on.
      try {
        if ((await repair(c)) === "deferred") deferred.push(c);
      } catch (e) {
        console.error(`${c.orderNumber}: FAILED —`, e);
        failed.push({ orderNumber: c.orderNumber, error: e });
      }
    }
    if (deferred.length === pending.length) {
      for (const c of deferred) {
        console.log(`${c.orderNumber}: original is itself an unrepaired replacement (skipped/failed above) — SKIP`);
        skipped.push({ orderNumber: c.orderNumber, reason: "original is an unrepaired replacement" });
      }
      break;
    }
    pending = deferred;
  }

  const list = (xs: string[]) => xs.join(", ") || "-";
  console.log("\n=== SUMMARY ===");
  console.log(`fixed (${fixed.length}): ${list(fixed)}`);
  console.log(`link only (${linkOnly.length}): ${list(linkOnly)}`);
  console.log(`would-fix, dry run (${wouldFix.length}): ${list(wouldFix)}`);
  console.log(`would-link-only, dry run (${wouldLinkOnly.length}): ${list(wouldLinkOnly)}`);
  console.log(
    `skipped (${skipped.length}): ${
      skipped.map((s) => `${s.orderNumber} [${s.reason}]`).join(", ") || "-"
    }`
  );
  console.log(`failed (${failed.length}): ${list(failed.map((f) => f.orderNumber))}`);

  return { failed };
}
main()
  .then(({ failed }) => process.exit(failed.length ? 1 : 0))
  .catch((e) => { console.error(e); process.exit(1); });
