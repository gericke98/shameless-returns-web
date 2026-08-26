import { NextResponse } from "next/server";
import { getAmphoraReturns } from "@/actions/amphora";
import {
  getOrdersWithUnsettledReturns,
  getReturnStatusesByIds,
  getVariantSkusByIds,
} from "@/db/queries";
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";
import { decideAutoApprove, type GateLine } from "@/lib/autoApproveGate";
import { settleReturnLine } from "@/lib/settleReturn";
import { alertOps } from "@/actions/opsAlert";

/**
 * Settle the returns that are already sitting in the warehouse.
 *
 * Every return in this business is settled by hand today: a human opens the
 * dashboard, decides the return is fine, and clicks. For the overwhelming
 * majority they are confirming two facts — the goods came back, and we have not
 * already paid — and both are readable. This job reads them.
 *
 * DRY BY DEFAULT. `AUTO_APPROVE_ENABLED` must be set to "true" before a single
 * euro moves, so deploying this route does nothing until someone deliberately
 * arms it.
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret =
 *  closed, never open — this route pays customers. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  // Armed only by an explicit env var. An operator who deploys and forgets gets
  // a report, not a hundred payouts.
  const dry =
    url.searchParams.get("dry") === "1" || process.env.AUTO_APPROVE_ENABLED !== "true";
  const cap = intEnv("AUTO_APPROVE_MAX_PER_RUN", 25);
  const graceDays = intEnv("AUTO_APPROVE_GRACE_DAYS", 2);

  let returns;
  try {
    returns = await getAmphoraReturns();
  } catch (error: any) {
    console.error("[auto-approve] could not list returns:", error?.message || error);
    return NextResponse.json({ error: "Amphora unreachable" }, { status: 502 });
  }

  const amphoraByOrderId = new Map(
    matchReturnsToOrderIds(returns).map((m) => [m.orderId, m.ret])
  );
  const orders = await getOrdersWithUnsettledReturns();

  // One batched Shopify read for the whole run, not one per order.
  const allReturnIds = orders.flatMap((o: any) =>
    o.products.filter((p: any) => !p.refunded && p.return_id).map((p: any) => p.return_id)
  );
  let shopifyReturnStatus: Record<string, string | undefined>;
  try {
    shopifyReturnStatus = await getReturnStatusesByIds(allReturnIds);
  } catch (error: any) {
    // Without this we cannot tell paid from unpaid, and the whole point of the
    // job is not paying twice. Refuse the run.
    console.error("[auto-approve] could not read Shopify return statuses:", error?.message || error);
    return NextResponse.json({ error: "Shopify unreachable" }, { status: 502 });
  }

  const held: Array<{ order: string; reason: string }> = [];
  let scanned = 0;
  let settledCount = 0;
  let capped = false;

  for (const order of orders as any[]) {
    if (settledCount >= cap) {
      capped = true;
      break;
    }
    scanned += 1;

    try {
      const pendingRows = order.products.filter((p: any) => !p.refunded);
      const skusById = await getVariantSkusByIds(
        pendingRows.map((p: any) => String(p.variant_id))
      );

      const lines: GateLine[] = order.products.map((p: any) => ({
        id: String(p.id),
        variant_id: String(p.variant_id),
        quantity: Number(p.quantity),
        return_id: p.return_id ?? null,
        refunded: p.refunded ?? false,
        confirmed: p.confirmed ?? false,
        sku: skusById[String(p.variant_id)] ?? null,
      }));

      const verdict = decideAutoApprove({
        lines,
        amphora: (amphoraByOrderId.get(String(order.id)) as any) ?? null,
        shopifyReturnStatus,
        now: new Date(),
        graceDays,
      });

      if (!verdict.settle) {
        held.push({ order: order.orderNumber, reason: verdict.reason });
        continue;
      }

      for (const line of verdict.lines) {
        if (settledCount >= cap) {
          capped = true;
          break;
        }
        if (dry) {
          settledCount += 1;
          console.log(`[auto-approve] WOULD settle ${order.orderNumber} / ${line.variant_id}`);
          continue;
        }
        // The core re-reads the line from the database and refuses one already
        // marked refunded, which is what makes settling in a loop safe.
        //
        // Count only confirmed settlements. If this call throws, the outer
        // catch below reports the order as held without this line ever having
        // been counted — there is nothing to undo.
        const outcome = await settleReturnLine(
          order.products.find((p: any) => String(p.id) === line.id),
          order
        );
        if (outcome.settled) {
          settledCount += 1;
          console.log(`[auto-approve] settled ${order.orderNumber} / ${line.variant_id} (${outcome.lane})`);
        } else {
          held.push({ order: order.orderNumber, reason: `settle-refused:${outcome.reason}` });
        }
      }
    } catch (error: any) {
      // One bad order must not stop the sweep — the rest are still owed their
      // money. Alert, because by here money may have half-moved.
      console.error(`[auto-approve] ${order.orderNumber} failed:`, error?.message || error);
      held.push({ order: order.orderNumber, reason: "threw" });
      await alertOps(
        `[returns] AUTO-APPROVE FAILED — order ${order.orderNumber}`,
        [
          `The daily auto-approve run threw while settling ${order.orderNumber}.`,
          `Money may have moved partially. Check the order in Shopify before re-running.`,
          `Error: ${error?.message || error}`,
        ].join("\n")
      );
    }
  }

  // Name the held orders. A bare count tells whoever is on call that something
  // is waiting but not which customer — the delay this job exists to end.
  if (held.length) {
    console.warn(
      `[auto-approve] held ${held.length}: ` +
        held.map((h) => `${h.order} (${h.reason})`).join(", ")
    );
  }

  return NextResponse.json({ scanned, settled: settledCount, held, capped, dry });
}
