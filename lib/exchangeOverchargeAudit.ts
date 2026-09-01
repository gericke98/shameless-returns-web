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

// ---------------------------------------------------------------------------
// R19 — reconstructing the bundled pre-itemisation fee.
//
// For an all-same-product exchange the price difference is zero by
// construction (see isAllSameProductExchange above), so the ONLY thing a
// bundled "Returns & Exchanges Fee" line can legitimately contain is the
// shipping fee. That fee is reconstructible from the seeded fee table
// (lib/fees.ts / db/fees.ts, by destination zone and parcel weight) PROVIDED
// the order was priced under the same rules the fee table encodes today.
// Where it was not, reconstruction is unsound and the order must stay
// `indeterminate` rather than produce a number nobody should trust.
// ---------------------------------------------------------------------------

/** The minimal shape of a productsorder row this reconstruction needs. */
export type ReconstructionLine = {
  action: string | null;
  price: string;
  quantity: number;
};

/**
 * Rebuild the `Basket` fields `resolveFee` (lib/fees.ts) needs, from a
 * historical order's CURRENT productsorder rows.
 *
 * Two deliberate readings of "as it was at charge time", both explained
 * because they are not literal re-reads of history — nothing stores that:
 *
 * - `valueBasket`'s real filter is `item.action && !item.confirmed`. Every
 *   candidate here has since been settled, so `confirmed` is `true` on these
 *   rows NOW — filtering live data by `!confirmed` would find nothing. Every
 *   row that carries an `action` at all necessarily WAS unconfirmed at the
 *   moment `createStripeUrl` valued the basket (confirmation only happens
 *   later, when the Shopify return is actually created — see
 *   actions/updateOrder.ts). So "had an action and were not confirmed"
 *   collapses, for settled history, to simply "has an action".
 * - Weight: real per-item weight is NOT used. Every parcel in this window
 *   predates the parcelGrams fix (commit bc374a7, 2026-09-01) that finally
 *   let a variant's real weight be found, so every item — no exceptions —
 *   was actually weighed at `FALLBACK_ITEM_GRAMS` (500g) regardless of the
 *   catalogue. Using today's real catalogue weight here would silently
 *   reconstruct a fee that was never actually charged.
 *
 * `netAmount`: for an all-same-product CAMBIO line, `replacementPrice`'s
 * same-product short-circuit returns the line's own paid price verbatim, so
 * that line's contribution to `returnPrice` and `exchangePrice` is identical
 * and cancels. What survives in netAmount is only the price of any bundled
 * plain-return ("DEVOLUCIÓN") lines — which flips `resolveFee`'s Rule A from
 * "exchange" to "return" if they are present, exactly as it does live.
 */
export function reconstructBasketFromLines(
  lines: ReconstructionLine[],
  fallbackItemGrams: number
): { hasItems: boolean; netAmount: number; grams: number } {
  const active = lines.filter((l) => l.action != null);
  const returnPrice = active.reduce(
    (sum, l) => sum + (parseFloat(l.price) || 0),
    0
  );
  const exchangePrice = active
    .filter((l) => l.action === "CAMBIO")
    .reduce((sum, l) => sum + (parseFloat(l.price) || 0), 0);
  const grams = active.reduce(
    (sum, l) => sum + fallbackItemGrams * Math.max(1, Number(l.quantity) || 1),
    0
  );
  return { hasItems: active.length > 0, netAmount: returnPrice - exchangePrice, grams };
}

// Unix seconds (Stripe's `session.created` unit) for the two points where the
// LIVE fee-computation rules stopped matching what today's `shipping_fees`
// table + `resolveFee` would compute — verified against git history, not
// assumed:
//
//  - EXCHANGE_FEE_MODEL_CUTOVER_UNIX = the merge of PR #15 (commit 7919d72,
//    2026-07-28T23:25:35+02:00 authored; merged as 22a7657 at
//    2026-07-28T23:48:20+02:00 = 2026-07-28T21:48:20Z). Before this, an
//    exchange's fee was `return fee, minus EUR 1` — a completely different,
//    known-wrong formula (see that commit's message) — not today's
//    `exchangeFeeCents` (= return + outbound leg). This also strictly
//    subsumes the whole same-day churn on 2026-07-28 that came before it
//    (the initial per-country + per-weight seed at ~16:49 CEST, the
//    real-carrier-cost fix at 16:57, the Spain zone split at 18:34): all of
//    it is earlier than this cutover, so one boundary covers all of it.
//  - ISRAEL_REPRICE_CUTOVER_UNIX = the merge of PR #23 (commit 38aeb59,
//    merged as 6f34f20 at 2026-07-29T13:49:06+02:00 = 2026-07-29T11:49:06Z).
//    The carrier cut Israel by a flat EUR 30 at every band; nothing else in
//    the tariff moved. Because the `*` fallback zone is DERIVED as the
//    maximum fee at each band, this also moved `*` (Israel had been the
//    ceiling; Cyprus took over). Between the two cutovers, an order zoned
//    IL, or zoned to `*` (an unrecognised country or a country absent from
//    the table), was charged a rate today's table no longer has — so
//    reconstruction is unsound for those specific orders in that specific
//    ~14-hour window, even though the general model was already correct.
export const EXCHANGE_FEE_MODEL_CUTOVER_UNIX = 1785275300;
export const ISRAEL_REPRICE_CUTOVER_UNIX = 1785325746;

/**
 * Is it sound to compare this order's bundled Stripe charge against what
 * TODAY's fee table says it should have been?
 */
export function isReconstructionSound(params: {
  sessionCreatedUnix: number;
  zone: string | null;
  usedFallbackZone: boolean;
}): boolean {
  if (params.sessionCreatedUnix < EXCHANGE_FEE_MODEL_CUTOVER_UNIX) return false;
  const israelRateExposed = params.zone === "IL" || params.usedFallbackZone;
  if (israelRateExposed && params.sessionCreatedUnix < ISRAEL_REPRICE_CUTOVER_UNIX) {
    return false;
  }
  return true;
}

export type ReconstructedStatus =
  | "reconstructed"
  | "reconstructed-clean"
  | "reconstructed-undercharged";

/**
 * Compare what was actually charged (the single bundled line) against what
 * the current fee table says should have been charged.
 *
 * Three outcomes, not two: the brief only names `reconstructed` (an
 * overcharge) and `reconstructed-clean` (a match), but a residual can also
 * run the other way — the bundled amount UNDER the expected fee, which is
 * not a customer harm (our shortfall, not theirs) and must not be silently
 * folded into "clean" (that would misreport a real, non-zero residual as
 * "nothing to see") or into "reconstructed" (which this audit reserves for
 * the overcharge direction it exists to measure).
 */
export function classifyResidual(
  bundledCents: number,
  expectedFeeCents: number
): { status: ReconstructedStatus; residualCents: number } {
  const residualCents = bundledCents - expectedFeeCents;
  if (residualCents > 1) return { status: "reconstructed", residualCents };
  if (residualCents < -1) {
    return { status: "reconstructed-undercharged", residualCents };
  }
  return { status: "reconstructed-clean", residualCents };
}
