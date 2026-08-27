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
// 300, not the 60 copied from `amphora-sync`. A settled line costs roughly six
// Shopify round trips plus five database ones, so a full run of the cap does
// not fit in a minute — and a run killed mid-flight is not merely slow. If the
// process dies between the payout and the `refunded` flag a few lines later,
// nothing records that we paid: `refunded` is still false, the Shopify return
// still reads OPEN, Amphora still reads RECEIVED, and the next run mints a
// SECOND gift card for the same garment. The wall-clock budget below is the
// real guard; this only widens the window it works inside.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Stop STARTING new settlements this long into the run. Well inside
 *  `maxDuration` so the settlement already in flight can finish writing its
 *  `refunded` flag rather than being cut in half, and so the response still
 *  gets sent. Bound the window rather than gambling on it. */
const BUDGET_MS = 40_000;

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret =
 *  closed, never open — this route pays customers. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Read a non-negative integer from the environment.
 *
 * The empty string is checked BEFORE `Number()`, because `Number("")` is 0 and
 * `0 >= 0` passes — so a variable added in the Vercel dashboard and left blank
 * would silently mean "grace period: none", and a return marked RECEIVED sixty
 * seconds ago would settle. Blank is not a number; it is an absent value, and
 * an absent value takes the default.
 */
function intEnv(name: string, fallback: number): number {
  const value = (process.env[name] ?? "").trim();
  if (value === "") return fallback;
  const raw = Number(value);
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

  // Likewise ONE read for every pending line in the sweep. This used to sit
  // inside the loop — one Shopify round trip per scanned order, which on the
  // current backlog is on its own most of a minute before a single euro moves.
  const allPendingVariantIds = orders.flatMap((o: any) =>
    o.products.filter((p: any) => !p.refunded).map((p: any) => String(p.variant_id))
  );
  let skusById: Record<string, string>;
  try {
    skusById = await getVariantSkusByIds(allPendingVariantIds);
  } catch (error: any) {
    // An unresolved SKU is never eligible, so a failure here would hold every
    // order for a reason that says nothing. Refuse the run instead.
    console.error("[auto-approve] could not read variant SKUs:", error?.message || error);
    return NextResponse.json({ error: "Shopify unreachable" }, { status: 502 });
  }

  const held: Array<{ order: string; reason: string }> = [];
  let scanned = 0;
  let settledCount = 0;
  let capped = false;
  let budgetExhausted = false;
  const startedAt = Date.now();

  for (const order of orders as any[]) {
    if (settledCount >= cap) {
      capped = true;
      break;
    }
    if (Date.now() - startedAt >= BUDGET_MS) {
      budgetExhausted = true;
      break;
    }
    scanned += 1;

    // Named for the alert below: only a throw AFTER this flips may claim money
    // might have moved.
    let enteredSettle = false;
    const label = order.orderNumber ?? String(order.id);

    try {
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
        held.push({ order: label, reason: verdict.reason });
        continue;
      }

      // The exchange lane settles EVERY pending exchange line of an order in
      // one call. Without this, the siblings it just paid come back around the
      // loop, get refused as already-refunded, and land in `held` as if they
      // had failed — which would make the one report this job produces lie.
      const alreadySettled = new Set<string>();

      for (const line of verdict.lines) {
        if (alreadySettled.has(line.id)) continue;
        if (settledCount >= cap) {
          capped = true;
          break;
        }
        if (Date.now() - startedAt >= BUDGET_MS) {
          budgetExhausted = true;
          break;
        }
        if (dry) {
          settledCount += 1;
          console.log(`[auto-approve] WOULD settle ${label} / ${line.variant_id}`);
          continue;
        }
        // The core re-reads the line from the database and refuses one already
        // marked refunded, which is what makes settling in a loop safe.
        //
        // Count only confirmed settlements. If this call throws, the outer
        // catch below reports the order as held without this line ever having
        // been counted — there is nothing to undo.
        enteredSettle = true;
        const outcome = await settleReturnLine(
          order.products.find((p: any) => String(p.id) === line.id),
          order
        );
        if (outcome.settled) {
          // Count what was actually flipped, not the one line we asked about.
          settledCount += outcome.lineIds.length;
          for (const id of outcome.lineIds) alreadySettled.add(id);
          console.log(`[auto-approve] settled ${label} / ${line.variant_id} (${outcome.lane}, ${outcome.lineIds.length} line(s))`);
        } else {
          held.push({ order: label, reason: `settle-refused:${outcome.reason}` });
        }
      }
    } catch (error: any) {
      // One bad order must not stop the sweep — the rest are still owed their
      // money.
      console.error(`[auto-approve] ${label} failed:`, error?.message || error);
      held.push({ order: label, reason: "threw" });
      // Say only what is true. A throw BEFORE the first `settleReturnLine`
      // cannot have moved a cent, and an alert that says otherwise sends
      // whoever is on call hunting a refund that never happened — this repo
      // has already done that once.
      await alertOps(
        enteredSettle
          ? `[returns] AUTO-APPROVE FAILED — order ${label}`
          : `[returns] AUTO-APPROVE HELD — order ${label}`,
        enteredSettle
          ? [
              `The daily auto-approve run threw while settling ${label}.`,
              `Money may have moved partially. Check the order in Shopify before re-running.`,
              `Error: ${error?.message || error}`,
            ].join("\n")
          : [
              `The daily auto-approve run threw while EVALUATING ${label}, before any payout was attempted.`,
              `NO MONEY MOVED and nothing was written. The order is simply held for the next run.`,
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

  if (budgetExhausted) {
    console.warn(
      `[auto-approve] stopped at the ${BUDGET_MS}ms budget after ${scanned} orders; the rest wait for the next run.`
    );
  }

  return NextResponse.json({
    scanned,
    settled: settledCount,
    held,
    capped,
    budgetExhausted,
    dry,
  });
}
