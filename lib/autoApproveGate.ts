/**
 * May this order be settled without a human looking at it?
 *
 * Pure — no db, no network, no env, no clock. Every input is passed in so the
 * whole decision is unit-testable, because this function is the only thing
 * standing between an automated cron and someone's money.
 *
 * It answers TWO independent questions, and needs both:
 *   · did the goods come back?      — Amphora's `quantity_received`
 *   · have we already paid?          — the Shopify return status
 * Amphora knows nothing about the second. A gate built only on Amphora would
 * have re-refunded ~49 customers on its first run (see the design doc).
 */

/** The only statuses that mean "the warehouse has our garments".
 *
 *  An ALLOWLIST on purpose. Across 143 live returns not one EXCEPTION* or
 *  FINISHED_REJECTED exists, so we have never seen what a rejected return looks
 *  like on the wire. A blocklist would pay out on any status we failed to
 *  predict; this refuses everything it does not recognise. */
const WAREHOUSE_STATUSES = new Set(["RECEIVED", "PROCESSING_WAREHOUSE", "FINISHED"]);

const MS_PER_DAY = 86_400_000;

export type GateLine = {
  id: string;
  variant_id: string;
  quantity: number;
  return_id: string | null;
  refunded: boolean | null;
  confirmed: boolean | null;
  /** Resolved from Shopify; null when we could not, which is never eligible. */
  sku: string | null;
};

export type GateAmphoraReturn = {
  internal_status: string;
  time_received?: string | null;
  items?: Array<{
    sku: string | null;
    quantity: number | string;
    quantity_received: number | string;
  }>;
};

export type GateInput = {
  lines: GateLine[];
  amphora: GateAmphoraReturn | null;
  /** Shopify `Return.status` by return gid. A gid ABSENT from this map could
   *  not be read, and must never be treated as OPEN. */
  shopifyReturnStatus: Record<string, string | undefined>;
  now: Date;
  graceDays: number;
};

export type GateVerdict =
  | { settle: true; lines: GateLine[] }
  | { settle: false; reason: string };

/** Amphora sends counts as strings — `"0"` is truthy, so never test one for
 *  truthiness. NaN for anything unparseable, which fails every comparison
 *  below and so refuses to settle. */
function count(value: unknown): number {
  return Number(String(value ?? "").trim());
}

/** Amphora sends both bare local stamps and offset-aware ones. Read a bare one
 *  as UTC so this decides the same on a laptop and in a Vercel function —
 *  the same rule as `lib/amphoraReturnMatch.ts::createdAt`. */
function parseStamp(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const iso = /[Z+]|-\d{2}:\d{2}$/.test(stamp) ? stamp : `${stamp}Z`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function decideAutoApprove(input: GateInput): GateVerdict {
  const pending = input.lines.filter((l) => l.confirmed === true && !l.refunded);
  if (pending.length === 0) return { settle: false, reason: "nothing-to-settle" };

  const ret = input.amphora;
  if (!ret) return { settle: false, reason: "no-amphora-record" };

  const status = String(ret.internal_status ?? "").trim().toUpperCase();
  if (!WAREHOUSE_STATUSES.has(status)) {
    return { settle: false, reason: `status-not-in-warehouse:${status || "(empty)"}` };
  }

  const receivedAt = parseStamp(ret.time_received);
  if (receivedAt == null) return { settle: false, reason: "no-receipt-timestamp" };
  if (input.now.getTime() - receivedAt < input.graceDays * MS_PER_DAY) {
    return { settle: false, reason: "within-grace" };
  }

  // Did the warehouse actually count our garments in? Drawn from a POOL rather
  // than compared per line, so two lines of the same SKU cannot both claim one
  // received garment.
  const pool = new Map<string, number>();
  for (const item of ret.items ?? []) {
    const sku = String(item.sku ?? "").trim();
    if (!sku) continue;
    pool.set(sku, (pool.get(sku) ?? 0) + count(item.quantity_received));
  }
  for (const line of pending) {
    const sku = String(line.sku ?? "").trim();
    if (!sku) return { settle: false, reason: `unresolved-sku:${line.variant_id}` };
    const available = pool.get(sku) ?? 0;
    // NaN fails this comparison, which is the intent.
    if (!(available >= line.quantity)) {
      return { settle: false, reason: `short-receipt:${sku}` };
    }
    pool.set(sku, available - line.quantity);
  }

  // Have we already paid? `refunded` above is OUR record of that, and it drifts:
  // anything settled in the Shopify admin never comes back through the button.
  for (const line of pending) {
    if (!line.return_id) return { settle: false, reason: `no-return-id:${line.id}` };
    const shopify = input.shopifyReturnStatus[line.return_id];
    if (shopify === undefined) {
      return { settle: false, reason: `shopify-unreadable:${line.return_id}` };
    }
    if (shopify !== "OPEN") {
      return { settle: false, reason: `shopify-not-open:${shopify}` };
    }
  }

  return { settle: true, lines: pending };
}
