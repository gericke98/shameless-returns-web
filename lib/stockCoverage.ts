// Does Amphora's stock cover a replacement? (FX plan rev 2, §#2.) Pure: the
// read comes from lib/server/amphoraStock.ts `readAvailable`, the open demand
// from lib/settlement/ledger.ts `openExchangeDemand`; this only does the sums.
//
// Identity is the SKU, the identifier both systems declare for a product
// (Amphora == Shopify variant SKU). Demand is summed PER SKU over every line
// mapped to it: two lines × 1 against 1 available is short, and so is one
// line × 2.
//
// Covered ⇔ available − earlier ≥ need, per SKU, where `earlier` is demand
// already promised (open exchange lines of earlier-accepted submissions). An
// unreadable stock read is a value of its own — never 0, never "enough".
import { variantGid } from "@/lib/shopifyIds";

export type StockRow = { productId: string; locationId: string; available: number };

export type StockRead =
  | {
      ok: true;
      /** One row per SKU, at the warehouse that ships Shopify orders. */
      bySku: Map<string, StockRow>;
      /** Variant gid → its SKU, for every variant the read was asked about. */
      skuOf: Map<string, string>;
    }
  | { ok: false; reason: string };

/** One line asking for a replacement variant. */
export type DemandLine = { variantGid: string; quantity: number };

export type Shortfall = { sku: string; need: number; available: number; earlier: number };

export type Coverage = { ok: true } | { ok: false; short: Shortfall[] };

export type Assessment =
  | { kind: "covered" }
  | { kind: "short"; short: Shortfall[] }
  | { kind: "unreadable"; reason: string };

/** Units per SKU over these lines. A line whose variant has no SKU is a reason, not a zero. */
export function need(
  lines: readonly DemandLine[],
  skuOf: ReadonlyMap<string, string>
): { ok: true; bySku: Map<string, number> } | { ok: false; reason: string } {
  const bySku = new Map<string, number>();
  for (const line of lines) {
    // Either stored shape of a variant id (bare or gid) names the same variant.
    const sku = skuOf.get(variantGid(line.variantGid) ?? "");
    if (!sku) return { ok: false, reason: `no-sku:${line.variantGid}` };
    bySku.set(sku, (bySku.get(sku) ?? 0) + line.quantity);
  }
  return { ok: true, bySku };
}

/** Covered ⇔ available − earlier ≥ need, for every SKU needed. */
export function covers(
  needed: ReadonlyMap<string, number>,
  available: ReadonlyMap<string, number>,
  earlier: ReadonlyMap<string, number>
): Coverage {
  const short: Shortfall[] = [];
  for (const [sku, units] of Array.from(needed)) {
    const have = available.get(sku) ?? 0;
    const promised = earlier.get(sku) ?? 0;
    if (have - promised < units) short.push({ sku, need: units, available: have, earlier: promised });
  }
  return short.length === 0 ? { ok: true } : { ok: false, short };
}

/**
 * The whole judgement: this basket against the read, net of earlier demand.
 * Earlier lines on SKUs this basket does not need cannot change the answer.
 */
export function assess(read: StockRead, basket: readonly DemandLine[], earlier: readonly DemandLine[]): Assessment {
  if (!read.ok) return { kind: "unreadable", reason: read.reason };
  const needed = need(basket, read.skuOf);
  if (!needed.ok) return { kind: "unreadable", reason: needed.reason };
  const promised = need(earlier, read.skuOf);
  if (!promised.ok) return { kind: "unreadable", reason: promised.reason };
  const available = new Map<string, number>();
  for (const sku of Array.from(needed.bySku.keys())) {
    const row = read.bySku.get(sku);
    if (!row) return { kind: "unreadable", reason: `not-at-amphora:${sku}` };
    available.set(sku, row.available);
  }
  const verdict = covers(needed.bySku, available, promised.bySku);
  return verdict.ok ? { kind: "covered" } : { kind: "short", short: verdict.short };
}
