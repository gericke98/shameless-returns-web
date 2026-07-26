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

export type FeeTable = Readonly<Record<string, CountryFees>>;

export type FeeKind = "return" | "exchange" | "none";

export type Basket = {
  /** Any item selected for return or exchange and not already confirmed. */
  readonly hasItems: boolean;
  /** Value returned minus value of replacement items, in euros. Positive
   *  means the customer is owed money. */
  readonly netAmount: number;
};

/** Row that every unlisted or unrecognised country falls back to. */
export const DEFAULT_FEE_KEY = "*";

const ZERO: CountryFees = { returnFeeCents: 0, exchangeFeeCents: 0 };

/**
 * Pick the fee pair for a country. An unknown, unlisted or null country
 * falls back to the '*' row; if that row is missing too, fees are zero
 * rather than NaN — undercharging is recoverable, a NaN checkout is not.
 */
export function feesForCountry(
  table: FeeTable,
  country: string | null | undefined
): CountryFees {
  if (country && table[country]) return table[country];
  return table[DEFAULT_FEE_KEY] ?? ZERO;
}

/**
 * Rule A — by net amount.
 *
 * Empty basket    -> no fee.
 * netAmount > 0   -> the customer is getting money back: return fee.
 * otherwise       -> the customer owes or breaks even: exchange fee.
 */
export function resolveFee(
  fees: CountryFees,
  basket: Basket
): { feeCents: number; kind: FeeKind } {
  if (!basket.hasItems) return { feeCents: 0, kind: "none" };
  if (basket.netAmount > 0) {
    return { feeCents: fees.returnFeeCents, kind: "return" };
  }
  return { feeCents: fees.exchangeFeeCents, kind: "exchange" };
}

/**
 * Do not chain arithmetic on the result — summing two euro values converted
 * here can reintroduce binary float drift, exactly what the "money is
 * integer cents" rule exists to prevent. Add in cents, convert once, last.
 */
export function centsToEuros(cents: number): number {
  return Math.round(cents) / 100;
}
