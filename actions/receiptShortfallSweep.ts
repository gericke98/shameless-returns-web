// Short-receipt detection: the warehouse counted fewer units of a SKU than the
// customer still has open. Records each case, resolves it on evidence, and
// alerts ops durably (stage 1 at once, stage 2 after 7 days unresolved).
//
// NOT a server action: nothing here is callable from a client. Runs from
// /api/cron/receipt-shortfalls. It never settles, refunds or emails a customer.
import { getAmphoraReturns } from "@/actions/amphora";
import { enqueueOpsAlerts } from "@/actions/opsAlertOutbox";
import {
  getOrderByIdFresh,
  getOrdersWithUnsettledReturns,
  getReturnStatusesByIds,
  getVariantSkusByIds,
} from "@/db/queries";
import {
  advanceShortfallStages,
  listOpenShortfalls,
  recordShortfall,
  resolveShortfallsForOrder,
  resolveShortfallsForReturn,
  shortfallAlertKey,
  type ShortfallRow,
} from "@/db/receiptShortfalls";
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";
import { observeReturnReceipt, type ObservedLine } from "@/lib/receiptObservation";

export const ESCALATE_AFTER_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export type ShortfallSweepReport = {
  scanned: number;
  short: number;
  resolved: number;
  unknown: number;
  failed: number;
  alertsQueued: number;
  alertsNotQueued: number;
};

type SweepOrder = {
  id: string;
  orderNumber?: string | null;
  email?: string | null;
  products: any[];
};

/** One sweep. Throws only when an upstream read every order depends on fails
 *  (Amphora list, Shopify SKUs/statuses, the open-case list); per-order
 *  failures are counted and the rest go ahead. */
export async function sweepReceiptShortfalls(
  now: Date = new Date()
): Promise<ShortfallSweepReport> {
  const report: ShortfallSweepReport = {
    scanned: 0, short: 0, resolved: 0, unknown: 0, failed: 0, alertsQueued: 0, alertsNotQueued: 0,
  };

  // Conflicted records are refused here exactly as in the other crons (and
  // reported by amphora-sync): the order gets no record and observes `unknown`.
  const { matches } = matchReturnsToOrderIds(await getAmphoraReturns());
  const matchByOrderId = new Map(matches.map((m) => [m.orderId, m]));

  const candidates = (await getOrdersWithUnsettledReturns()) as SweepOrder[];
  const openBefore = await listOpenShortfalls();

  // An open case whose order dropped out of the candidate query (all lines
  // settled, say) still needs a POSITIVE observation to resolve: read it.
  const candidateIds = new Set(candidates.map((o) => String(o.id)));
  const missingIds = Array.from(
    new Set(openBefore.map((r) => r.orderId).filter((id) => !candidateIds.has(id)))
  );
  const fetched = await Promise.all(missingIds.map((id) => getOrderByIdFresh(id)));
  const orders: SweepOrder[] = [
    ...candidates,
    ...(fetched.filter(Boolean) as unknown as SweepOrder[]),
  ];

  const confirmedLines = (o: SweepOrder) => o.products.filter((p) => p.confirmed === true);
  const skusById = await getVariantSkusByIds(
    orders.flatMap((o) => confirmedLines(o).map((p) => String(p.variant_id)))
  );
  const shopifyReturnStatus = await getReturnStatusesByIds(
    orders.flatMap((o) =>
      confirmedLines(o).filter((p) => !p.refunded && p.return_id).map((p) => p.return_id)
    )
  );

  for (const order of orders) {
    report.scanned += 1;
    try {
      const lines: ObservedLine[] = confirmedLines(order).map((p) => ({
        variant_id: String(p.variant_id),
        quantity: Number(p.quantity),
        refunded: p.refunded ?? false,
        confirmed: true,
        return_id: p.return_id ?? null,
        sku: skusById[String(p.variant_id)] ?? null,
      }));
      const match = matchByOrderId.get(String(order.id)) ?? null;
      const observation = observeReturnReceipt({
        lines,
        amphora: (match?.ret as any) ?? null,
        shopifyReturnStatus,
      });

      switch (observation.kind) {
        case "settled":
        case "closed-in-shopify":
          report.resolved += await resolveShortfallsForOrder(String(order.id));
          break;
        case "ok":
          report.resolved += await resolveShortfallsForReturn(match!.amphoraReturnId, []);
          break;
        case "short": {
          const shopifyReturnIds = Array.from(
            new Set(lines.filter((l) => !l.refunded && l.return_id).map((l) => l.return_id!))
          );
          for (const s of observation.skus) {
            await recordShortfall({
              amphoraReturnId: match!.amphoraReturnId,
              orderId: String(order.id),
              sku: s.sku,
              shopifyReturnIds,
              declaredQty: s.declared,
              receivedQty: s.received,
            });
          }
          report.short += observation.skus.length;
          report.resolved += await resolveShortfallsForReturn(
            match!.amphoraReturnId,
            observation.skus.map((s) => s.sku)
          );
          break;
        }
        case "unknown":
          report.unknown += 1;
          break;
      }
    } catch (error: any) {
      report.failed += 1;
      console.error(
        `[receipt-shortfalls] ${order.orderNumber ?? order.id} failed:`,
        error?.message || error
      );
    }
  }

  // Stages advance only on what Postmark accepted (read from the outbox), then
  // whatever is due is queued. Re-queuing an already-queued key is a no-op.
  await advanceShortfallStages();
  const orderById = new Map(orders.map((o) => [String(o.id), o]));
  const due = (await listOpenShortfalls()).flatMap((row) => {
    const stage = dueStage(row, now);
    return stage ? [shortfallAlert(row, orderById.get(row.orderId) ?? null, stage)] : [];
  });
  const { failed } = await enqueueOpsAlerts(due);
  report.alertsQueued = due.length - failed;
  report.alertsNotQueued = failed;

  return report;
}

/** Which alert, if any, an open case is owed now. */
export function dueStage(
  row: Pick<ShortfallRow, "alertStage" | "firstAlertAcceptedAt">,
  now: Date
): 1 | 2 | null {
  if (row.alertStage === 0) return 1;
  if (
    row.alertStage === 1 &&
    row.firstAlertAcceptedAt &&
    now.getTime() - new Date(row.firstAlertAcceptedAt).getTime() >= ESCALATE_AFTER_DAYS * MS_PER_DAY
  ) {
    return 2;
  }
  return null;
}

export function shortfallAlert(
  row: ShortfallRow,
  order: SweepOrder | null,
  stage: 1 | 2
): { dedupeKey: string; subject: string; body: string } {
  const label = order?.orderNumber ?? `order id ${row.orderId}`;
  const dashboard = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard`;
  return {
    dedupeKey: shortfallAlertKey(row, stage),
    subject:
      stage === 1
        ? `[returns] SHORT RECEIPT — ${label} (${row.sku})`
        : `[returns] SHORT RECEIPT UNRESOLVED ${ESCALATE_AFTER_DAYS} DAYS — ${label} (${row.sku})`,
    body: [
      stage === 2
        ? `This short receipt was first reported ${ESCALATE_AFTER_DAYS} days ago and is still open.`
        : `The warehouse counted fewer units than the customer returned on this order.`,
      ``,
      `Order:      ${label}`,
      `Customer:   ${order?.email ?? "(unknown)"}`,
      `SKU:        ${row.sku} — declared ${row.declaredQty}, received ${row.receivedQty}`,
      `Amphora:    ${row.amphoraReturnId}`,
      `Shopify:    ${(row.shopifyReturnIds ?? []).join(", ") || "(none)"}`,
      `Dashboard:  ${dashboard}`,
      ``,
      `Auto-approve holds this order until it is resolved. What to do:`,
      `- Ask the customer whether they sent the garment.`,
      `- If they kept it: withdraw that line by hand.`,
      `- If they sent it: open an Amphora "order chn_ret" ticket to recount.`,
      ``,
      `This case closes by itself once the count is corrected, the lines are settled,`,
      `or the Shopify return is closed.`,
    ].join("\n"),
  };
}
