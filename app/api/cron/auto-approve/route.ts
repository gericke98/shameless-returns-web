import { NextResponse } from "next/server";
import { getAmphoraReturns } from "@/actions/amphora";
import {
  getOrdersWithUnsettledReturns,
  getReturnStatusesByIds,
  getVariantSkusByIds,
} from "@/db/queries";
import { matchConflictAlert, matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";
import { decideAutoApprove, type GateLine } from "@/lib/autoApproveGate";
import { submissionForRow } from "@/lib/settlement/legacy";
import { submissionOfRow } from "@/lib/settlement/ledger";
import { settleSubmission } from "@/lib/settlement/settle";
import { alertOps } from "@/actions/opsAlert";
import { enqueueOpsAlerts } from "@/actions/opsAlertOutbox";

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
// 300 gives the run room; it is no longer what keeps a payout from happening
// twice. Every external effect is an operation in the settlement ledger,
// claimed and dispatched through conditional UPDATEs before Shopify is called
// (lib/settlement/), so a run killed mid-flight leaves a `dispatched` row that
// the recovery cron judges from Shopify's own evidence — never a second card.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Stop STARTING new settlements this long into the run, well inside
 *  `maxDuration`, so the response still gets sent. Anything admitted and not
 *  yet run is finished by /api/cron/settlement-recovery. */
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

  // A conflicted Amphora record is refused by the matcher, so its order finds no
  // record here and is held. The alert is queued; /api/cron/ops-alerts delivers it.
  const { matches, conflicts } = matchReturnsToOrderIds(returns);
  const amphoraByOrderId = new Map(matches.map((m) => [m.orderId, m.ret]));
  const orders = await getOrdersWithUnsettledReturns();
  // Report what is ours: any conflict involving a record we created, and one
  // among Amphora's own records only when this run would otherwise settle it.
  const owedIds = new Set(orders.map((o: any) => String(o.id)));
  const { failed: alertsNotQueued } = await enqueueOpsAlerts(
    conflicts
      .filter((c) => c.createdByUs || (c.orderId !== null && owedIds.has(c.orderId)))
      .map(matchConflictAlert)
  );

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

  // Likewise ONE read for every confirmed line in the sweep. This used to sit
  // inside the loop — one Shopify round trip per scanned order, which on the
  // current backlog is on its own most of a minute before a single euro moves.
  // Settled lines too: the receipt pool nets out what they already used, so
  // their SKU is needed as much as a pending line's.
  const allVariantIds = orders.flatMap((o: any) =>
    o.products.map((p: any) => String(p.variant_id))
  );
  let skusById: Record<string, string>;
  try {
    skusById = await getVariantSkusByIds(allVariantIds);
  } catch (error: any) {
    // An unresolved SKU is never eligible, so a failure here would hold every
    // order for a reason that says nothing. Refuse the run instead.
    console.error("[auto-approve] could not read variant SKUs:", error?.message || error);
    return NextResponse.json({ error: "Shopify unreachable" }, { status: 502 });
  }

  const held: Array<{ order: string; reason: string }> = [];
  /** Admitted, not yet paid: in flight, goods pending, or unresolved. */
  const unfinished: Array<{ order: string; row: number; status: string }> = [];
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

      // Group the eligible lines by the agreement they belong to: settlement
      // executes a SUBMISSION, never a row. Rows confirmed before submissions
      // existed get a legacy one recorded at admission (S2 plan, D1) — only
      // when armed: a dry run writes nothing.
      const bySubmission = new Map<string, number[]>();
      const lineIds = verdict.lines.map((line) => Number(line.id));
      if (lineIds.length > cap - settledCount) capped = true;
      for (const id of lineIds.slice(0, Math.max(0, cap - settledCount))) {
        if (dry) {
          const existing = await submissionOfRow(id);
          settledCount += 1;
          console.log(
            `[auto-approve] WOULD settle ${label} / row ${id} (${existing ? `submission ${existing}` : "legacy submission to record"})`
          );
          continue;
        }
        const found = await submissionForRow(id);
        if (!found.ok) {
          held.push({ order: label, reason: `held:${found.held}` });
          await alertNotSettled(label, `held:${found.held}`);
          continue;
        }
        bySubmission.set(found.submissionId, [...(bySubmission.get(found.submissionId) ?? []), id]);
      }

      for (const [submissionId, ids] of Array.from(bySubmission)) {
        if (Date.now() - startedAt >= BUDGET_MS) {
          budgetExhausted = true;
          break;
        }
        enteredSettle = true;
        const report = await settleSubmission(submissionId, ids, {
          deadline: startedAt + BUDGET_MS,
        });
        for (const line of report.lines) {
          if (line.status.startsWith("held:")) {
            held.push({ order: label, reason: line.status });
            continue;
          }
          settledCount += 1;
          if (line.status !== "paid") {
            // In flight or unresolved: the ledger owns it now. Recovery
            // finishes what is in flight; an unresolved op already raised its
            // own durable alert.
            unfinished.push({ order: label, row: line.productsorderId, status: line.status });
          }
          console.log(`[auto-approve] ${label} / row ${line.productsorderId}: ${line.status}`);
        }
        const refused = report.lines.filter((l) => l.status.startsWith("held:"));
        if (refused.length) {
          await alertNotSettled(label, refused.map((l) => `row ${l.productsorderId}: ${l.status}`).join(", "));
        }
      }
    } catch (error: any) {
      // One bad order must not stop the sweep — the rest are still owed their
      // money.
      console.error(`[auto-approve] ${label} failed:`, error?.message || error);
      held.push({ order: label, reason: "threw" });
      // Say only what is true. A throw BEFORE the first `settleSubmission`
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
              `Every effect is an operation in the settlement ledger, so nothing is paid twice: anything dispatched is judged from Shopify's evidence by the recovery cron.`,
              `Check the order's settlement operations if this repeats.`,
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
    unfinished,
    capped,
    budgetExhausted,
    dry,
    conflicts: conflicts.length,
    alertsNotQueued,
  });
}

/**
 * A REFUSAL is not a gate hold. The gate holds for ordinary reasons by the
 * hundred; reaching here means the gate said yes and admission (or Shopify)
 * refused, so a customer is owed money and only a human can unstick it.
 *
 * Says only what the state proves (S2 plan L8): an admission hold sent
 * nothing to Shopify, so NO money moved; a rejected effect did not happen,
 * but a sibling effect of the same line (its gift card, say) may already be
 * done — and stays done, never repeated.
 */
async function alertNotSettled(label: string, reason: string) {
  const rejected = reason.includes("held:rejected:");
  await alertOps(
    `[returns] AUTO-APPROVE NOT SETTLED — order ${label}`,
    [
      `The daily auto-approve run judged ${label} eligible and then could not pay it.`,
      `Reason: ${reason}`,
      rejected
        ? `Shopify REJECTED an effect, so that effect did not happen. Any other effect of the line already recorded done stays done and is never repeated — check the order's settlement operations.`
        : `NO money moved — admission was refused, so nothing was sent to Shopify.`,
      `The customer is still owed. This will keep failing every run until someone looks.`,
    ].join("\n")
  );
}
