// Pure decision logic for scripts/audit-exchange-overcharges.ts.
//
// Split out from the script itself — which also does IO (Postgres, Stripe,
// Shopify) and calls `main()` at module load — so that unit tests can import
// only this file and never trigger a network call. See
// tests/auditExchangeOvercharges.test.ts.
import type { CatalogueIndex } from "@/lib/replacementPricing";

/** The minimal shape of a productsorder row this audit needs. */
export type SwapLine = {
  action: string | null;
  new_variant_id: string | null;
  productId: string;
};

/**
 * Every chosen replacement on this order's CAMBIO lines belongs to the
 * line's own product. An order with no CAMBIO+new_variant_id lines at all is
 * not an exchange, so it is not "all same product" — it is simply not a
 * candidate.
 *
 * This is what makes the audit exact: under the Task 1 rule, an order for
 * which this is true owes exactly EUR 0.00, with no catalogue arithmetic —
 * so any Stripe difference line charged against it IS the overcharge.
 */
export function isAllSameProductExchange(
  swaps: SwapLine[],
  index: Pick<CatalogueIndex, "productOf">
): boolean {
  if (swaps.length === 0) return false;
  return swaps.every(
    (l) => index.productOf(l.new_variant_id) === String(l.productId)
  );
}

// The Stripe line names are a closed set of four labels in two locales,
// written by actions/payments.ts from lib/i18n/{en,es}.ts:
//
//   kind             | en                    | es
//   -----------------|-----------------------|--------------------------------
//   difference       | New items             | Nuevos productos
//   shipping         | Shipping              | Envío
//   returnShipping   | Return shipping       | Envío de devolución
//   deliveryShipping | Delivery of new items | Envío de los nuevos productos
//
// "Delivery of new items" CONTAINS "new items" — a substring or negative
// regex match would score the outbound shipping leg as a price difference
// and invent a false overcharge. Match the closed set exactly.
export const DIFFERENCE_LABELS = new Set(["New items", "Nuevos productos"]);

// `createStripeUrl` falls back to this single bundled line whenever
// `checkoutLines` cannot decompose the amount exactly — every session
// created before itemisation shipped uses it. The difference cannot be
// separated from the shipping fee in that line, so it must be reported, not
// silently dropped or silently counted as either "exact" or "no-charge".
export const BUNDLED_FEE_LABEL = "Returns & Exchanges Fee";

export type LineStatus = "exact" | "indeterminate" | "no-charge";

export type ClassifiedLine = {
  description: string | null;
  amount_total: number | null;
};

export type Classification = {
  status: LineStatus;
  differenceCents: number | null;
  labels: string[];
};

/**
 * Classify a paid Stripe checkout session's line items.
 *
 * The bundled-fee check runs first defensively: `actions/payments.ts` never
 * emits it alongside itemised lines today (it is either the itemised list or
 * the single bundled line, never both), but checking it first keeps that
 * true even if that invariant ever changes.
 */
export function classifySessionLines(items: ClassifiedLine[]): Classification {
  const labels = items.map((li) => (li.description ?? "").trim());

  if (labels.includes(BUNDLED_FEE_LABEL)) {
    return { status: "indeterminate", differenceCents: null, labels };
  }

  const difference = items.find((li) =>
    DIFFERENCE_LABELS.has((li.description ?? "").trim())
  );
  if (difference && difference.amount_total) {
    return { status: "exact", differenceCents: difference.amount_total, labels };
  }

  return { status: "no-charge", differenceCents: null, labels };
}
