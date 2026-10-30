// Pure — no db, no network, no env, no clock. Did the warehouse count in fewer
// units of a SKU than the customer still has open on this return?
//
// Shared by the auto-approve gate (which must not pay a short return) and the
// receipt-shortfall sweep (which tells a human about one), so the two cannot
// disagree on what "short" means.
//
// The pool owner is the AMPHORA return: the warehouse counts one parcel, even
// when our lines carry several Shopify return gids for it. Per SKU:
//
//   supply = Σ quantity_received − Σ quantity of confirmed lines already settled
//   demand = Σ quantity of confirmed lines not yet settled
//   short  ⇔ demand > supply
//
// Subtracting what was already settled closes a gap the gate used to have: a
// settled line's received unit stayed in the pool and could satisfy a same-SKU
// sibling the customer never sent. That change can only hold more, never pay
// more.
//
// The answer is three-valued. `unknown` means "this cannot be decided from
// what we have" (an unresolved SKU, an unreadable count) and is neither a
// shortfall nor proof there is none: the gate holds on it, the sweep neither
// opens nor resolves a case on it.

export type ShortfallLine = {
  variant_id: string;
  quantity: number;
  refunded: boolean | null;
  confirmed: boolean | null;
  /** Resolved from Shopify; null when we could not. */
  sku: string | null;
};

export type ShortfallItem = {
  sku: string | null;
  quantity_received: number | string;
};

export type SkuShortfall = { sku: string; declared: number; received: number };

export type ShortfallVerdict =
  | { status: "ok" }
  | { status: "short"; skus: SkuShortfall[] }
  | { status: "unknown"; reason: string };

/** Amphora sends counts as strings — `"0"` is truthy, so never test one for
 *  truthiness. NaN for anything unparseable. */
export function amphoraCount(value: unknown): number {
  return Number(String(value ?? "").trim());
}

/**
 * Per SKU, for one Amphora return. `declared` is every confirmed unit of the
 * SKU on the order, `received` what the warehouse counted, so a short SKU
 * reads as "declared 2, received 1".
 */
export function shortfallsBySku(
  lines: ShortfallLine[],
  items: ShortfallItem[] | null | undefined
): ShortfallVerdict {
  const confirmed = lines.filter((l) => l.confirmed === true);

  const settled = new Map<string, number>();
  const pending = new Map<string, number>();
  for (const line of confirmed) {
    const sku = String(line.sku ?? "").trim();
    if (!sku) return { status: "unknown", reason: `unresolved-sku:${line.variant_id}` };
    if (!Number.isFinite(line.quantity) || line.quantity < 0) {
      return { status: "unknown", reason: `unreadable-quantity:${line.variant_id}` };
    }
    const bucket = line.refunded ? settled : pending;
    bucket.set(sku, (bucket.get(sku) ?? 0) + line.quantity);
  }

  const received = new Map<string, number>();
  for (const item of items ?? []) {
    const sku = String(item.sku ?? "").trim();
    if (!sku) continue;
    received.set(sku, (received.get(sku) ?? 0) + amphoraCount(item.quantity_received));
  }

  const short: SkuShortfall[] = [];
  // Array.from: this tsconfig targets ES5, which cannot iterate a Map directly.
  for (const [sku, demand] of Array.from(pending.entries())) {
    if (demand === 0) continue;
    const got = received.get(sku) ?? 0;
    // A NaN anywhere in this SKU's count makes it unknowable, not short.
    if (!Number.isFinite(got)) return { status: "unknown", reason: `unreadable-count:${sku}` };
    const supply = got - (settled.get(sku) ?? 0);
    if (demand > supply) {
      short.push({ sku, declared: demand + (settled.get(sku) ?? 0), received: got });
    }
  }

  return short.length ? { status: "short", skus: short } : { status: "ok" };
}
