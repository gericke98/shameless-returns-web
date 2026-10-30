// Pure — what one sweep pass may conclude about one order's receipt.
//
// Only three outcomes are evidence a case is over: every confirmed line is
// settled, every Shopify return still owed is CLOSED/CANCELED, or the warehouse
// count is now `ok`. A `short` opens (or keeps open) a case. Everything else is
// `unknown`, which neither opens nor resolves anything: in particular NOT
// seeing an order, or seeing it before Amphora finished counting, says nothing.
import { WAREHOUSE_STATUSES, parseAmphoraStamp } from "@/lib/autoApproveGate";
import {
  shortfallsBySku,
  type ShortfallItem,
  type ShortfallLine,
  type SkuShortfall,
} from "@/lib/receiptShortfall";

export type ObservedLine = ShortfallLine & { return_id: string | null };

export type ObservedAmphoraReturn = {
  internal_status?: string | null;
  time_processed?: string | null;
  items?: ShortfallItem[] | null;
};

export type ReceiptObservation =
  | { kind: "settled" }
  | { kind: "closed-in-shopify" }
  | { kind: "ok" }
  | { kind: "short"; skus: SkuShortfall[] }
  | { kind: "unknown"; reason: string };

const CLOSED_SHOPIFY = new Set(["CLOSED", "CANCELED"]);

export function observeReturnReceipt(input: {
  lines: ObservedLine[];
  /** The matched Amphora return; null when none or when the matcher refused it. */
  amphora: ObservedAmphoraReturn | null;
  /** Shopify `Return.status` by gid. An absent gid was not readable. */
  shopifyReturnStatus: Record<string, string | undefined>;
}): ReceiptObservation {
  const confirmed = input.lines.filter((l) => l.confirmed === true);
  const pending = confirmed.filter((l) => !l.refunded);
  if (pending.length === 0) return { kind: "settled" };

  if (
    pending.every(
      (l) => l.return_id && CLOSED_SHOPIFY.has(String(input.shopifyReturnStatus[l.return_id]))
    )
  ) {
    return { kind: "closed-in-shopify" };
  }

  const ret = input.amphora;
  if (!ret) return { kind: "unknown", reason: "no-amphora-record" };

  const status = String(ret.internal_status ?? "").trim().toUpperCase();
  if (!WAREHOUSE_STATUSES.has(status)) {
    return { kind: "unknown", reason: `not-in-warehouse:${status || "(empty)"}` };
  }
  // Detection starts as soon as Amphora has FINISHED the count — no grace.
  // Before that, a 0 is "not counted yet", not "not sent".
  if (parseAmphoraStamp(ret.time_processed) == null) {
    return { kind: "unknown", reason: "not-counted" };
  }

  const verdict = shortfallsBySku(confirmed, ret.items);
  if (verdict.status === "unknown") return { kind: "unknown", reason: verdict.reason };
  if (verdict.status === "short") return { kind: "short", skus: verdict.skus };
  return { kind: "ok" };
}
