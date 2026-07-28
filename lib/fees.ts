// The single source of truth for "what fee applies to this basket".
//
// Pure — no db, no env, no server-only imports — so client components can
// import it for display while payments.ts imports it for the real charge.
// Before this module, eight call sites each reimplemented the rule and two
// of them disagreed with the other six.

export type CountryFees = {
  readonly returnFeeCents: number;
  readonly exchangeFeeCents: number;
};

/** A fee pair that applies up to and including `maxGrams` of parcel weight. */
export type FeeBand = CountryFees & {
  readonly maxGrams: number;
};

/** A country's bands, ascending by maxGrams. Order is a precondition of
 *  `feesForWeight` — it returns the first band the parcel fits. */
export type CountryBands = readonly FeeBand[];

export type FeeTable = Readonly<Record<string, CountryBands>>;

export type FeeKind = "return" | "exchange" | "none";

export type Basket = {
  /** Any item selected for return or exchange and not already confirmed. */
  readonly hasItems: boolean;
  /** Value returned minus value of replacement items, in euros. Positive
   *  means the customer is owed money. */
  readonly netAmount: number;
  /** Weight of the parcel the customer ships back, in grams. The carrier
   *  prices by this, so it decides which band applies. */
  readonly grams: number;
};

/** Row that every unlisted or unrecognised country falls back to. */
export const DEFAULT_FEE_KEY = "*";

/**
 * The heaviest band's upper bound — "no parcel is heavier than this".
 *
 * Postgres `integer` tops out here, and 2147483 kg is comfortably beyond any
 * parcel a courier would accept. Every country must have exactly one band at
 * this value, or a heavy enough parcel would match no band and resolve to a
 * zero fee.
 */
export const UNBOUNDED_MAX_GRAMS = 2147483647;

const ZERO: CountryFees = { returnFeeCents: 0, exchangeFeeCents: 0 };

/**
 * Pick the band list for a country. An unknown, unlisted or null country
 * falls back to the '*' bands; if those are missing too, the result is empty
 * and `feesForWeight` yields zero rather than NaN — undercharging is
 * recoverable, a NaN checkout is not.
 */
export function feesForCountry(
  table: FeeTable,
  country: string | null | undefined
): CountryBands {
  if (country && table[country]?.length) return table[country];
  return table[DEFAULT_FEE_KEY] ?? [];
}

/**
 * The fee pair for a parcel of `grams`: the first band whose upper bound it
 * fits under.
 *
 * A negative or non-finite weight is treated as the lightest band rather than
 * throwing — a bad weight should not be able to block a return, and the
 * lightest band is the one a zero-weight parcel would honestly get.
 */
export function feesForWeight(bands: CountryBands, grams: number): CountryFees {
  if (bands.length === 0) return ZERO;
  const safe = Number.isFinite(grams) && grams > 0 ? grams : 0;
  for (const band of bands) {
    if (safe <= band.maxGrams) return band;
  }
  // Only reachable if the heaviest band is below UNBOUNDED_MAX_GRAMS, which
  // the seed and its test forbid. Charging the heaviest band beats charging
  // nothing.
  return bands[bands.length - 1];
}

/**
 * Rule A — by net amount.
 *
 * Empty basket    -> no fee.
 * netAmount > 0   -> the customer is getting money back: return fee.
 * otherwise       -> the customer owes or breaks even: exchange fee.
 */
export function resolveFee(
  bands: CountryBands,
  basket: Basket
): {
  feeCents: number;
  kind: FeeKind;
  /** The customer's parcel coming back. Always present when a fee applies. */
  returnLegCents: number;
  /** Delivering the replacement. Zero unless this is an exchange. */
  outboundLegCents: number;
} {
  if (!basket.hasItems) {
    return { feeCents: 0, kind: "none", returnLegCents: 0, outboundLegCents: 0 };
  }
  // Weight selects the band; Rule A then selects which of its two fees
  // applies. The two are independent — a heavier parcel does not change
  // whether this is a return or an exchange.
  const fees = feesForWeight(bands, basket.grams);

  if (basket.netAmount > 0) {
    return {
      feeCents: fees.returnFeeCents,
      kind: "return",
      returnLegCents: fees.returnFeeCents,
      outboundLegCents: 0,
    };
  }

  // An exchange is two journeys and its fee is the sum of both, so the split
  // is recoverable rather than stored. Clamped and derived by subtraction so
  // the two legs always add up to exactly what is charged, even if a
  // hand-edited row ever made the exchange fee the cheaper of the two.
  const outboundLegCents = Math.max(
    0,
    fees.exchangeFeeCents - fees.returnFeeCents
  );
  return {
    feeCents: fees.exchangeFeeCents,
    kind: "exchange",
    returnLegCents: fees.exchangeFeeCents - outboundLegCents,
    outboundLegCents,
  };
}

/** One row of the Stripe checkout, mirroring a row of the on-site summary. */
export type CheckoutLine = {
  readonly kind:
    | "difference"
    | "shipping"
    | "returnShipping"
    | "deliveryShipping";
  readonly amountCents: number;
};

/**
 * Break the amount owed into the lines the summary showed.
 *
 * Stripe was sent a single "Returns & Exchanges Fee" carrying the whole total,
 * which is wrong whenever the customer is also paying a price difference: swap
 * a 39.90 item for a 59.90 one and 20.00 of that "fee" is the item, not
 * shipping.
 *
 * Returns [] when the amount cannot be decomposed exactly — the caller then
 * falls back to a single line. That happens when the basket carries a credit
 * (a cheaper replacement leaves netAmount > 0, reducing the fee), because
 * Stripe line items cannot be negative, and it would also catch a cent of
 * float drift between the two ways of arriving at the total.
 *
 * The exact-sum check is the point: itemising must never change what is
 * charged, only how it is described.
 */
export function checkoutLines(
  basket: Basket,
  fee: { returnLegCents: number; outboundLegCents: number },
  amountCents: number
): readonly CheckoutLine[] {
  const differenceCents = Math.round(Math.max(0, -basket.netAmount) * 100);

  const lines: CheckoutLine[] = [];
  if (differenceCents > 0) {
    lines.push({ kind: "difference", amountCents: differenceCents });
  }
  if (fee.returnLegCents > 0) {
    lines.push({
      // Only worth calling it the *return* leg when there is another leg to
      // tell it apart from.
      kind: fee.outboundLegCents > 0 ? "returnShipping" : "shipping",
      amountCents: fee.returnLegCents,
    });
  }
  if (fee.outboundLegCents > 0) {
    lines.push({ kind: "deliveryShipping", amountCents: fee.outboundLegCents });
  }

  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return total === amountCents && lines.length > 0 ? lines : [];
}

/**
 * Do not chain arithmetic on the result — summing two euro values converted
 * here can reintroduce binary float drift, exactly what the "money is
 * integer cents" rule exists to prevent. Add in cents, convert once, last.
 */
export function centsToEuros(cents: number): number {
  return Math.round(cents) / 100;
}
