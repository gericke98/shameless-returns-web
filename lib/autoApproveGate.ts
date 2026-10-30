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
import { shortfallsBySku } from "@/lib/receiptShortfall";

/** The only statuses that mean "the warehouse has our garments".
 *
 *  An ALLOWLIST on purpose. Across 143 live returns not one EXCEPTION* or
 *  FINISHED_REJECTED exists, so we have never seen what a rejected return looks
 *  like on the wire. A blocklist would pay out on any status we failed to
 *  predict; this refuses everything it does not recognise. */
export const WAREHOUSE_STATUSES = new Set(["RECEIVED", "PROCESSING_WAREHOUSE", "FINISHED"]);

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

/** Amphora sends both bare local stamps and offset-aware ones. Read a bare one
 *  as UTC so this decides the same on a laptop and in a Vercel function. */
export function parseAmphoraStamp(stamp: string | null | undefined): number | null {
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

  const receivedAt = parseAmphoraStamp(ret.time_received);
  if (receivedAt == null) return { settle: false, reason: "no-receipt-timestamp" };
  if (input.now.getTime() - receivedAt < input.graceDays * MS_PER_DAY) {
    return { settle: false, reason: "within-grace" };
  }

  // Did the warehouse actually count our garments in? A POOL per SKU, net of
  // what is already settled, so two lines cannot both claim one received
  // garment and a paid line's unit cannot pay a sibling. Shared with the
  // receipt-shortfall sweep; `unknown` (unresolved SKU, unreadable count) holds.
  const receipt = shortfallsBySku(input.lines, ret.items);
  if (receipt.status === "unknown") return { settle: false, reason: receipt.reason };
  if (receipt.status === "short") {
    return { settle: false, reason: `short-receipt:${receipt.skus[0].sku}` };
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
