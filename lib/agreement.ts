// The customer's agreement for one submission, in integer cents.
//
// Pure: no db, no env. The portal total, the Stripe charge and the stored
// agreement are all read from this one function, so what the customer is shown,
// what Stripe takes and what settlement later owes cannot drift apart. Before
// it, three call sites each re-derived "fee, then ×1.15", and settlement
// derived a fourth answer of its own.
import type { ValuedLine } from "@/lib/basket";

/** Stripe refuses a EUR charge below this, so a smaller shortfall is waived. */
export const STRIPE_MINIMUM_CENTS = 50;

/** Store credit is paid at 115% of the cash value. */
const CREDIT_PERCENT = 115;

export type Tender = "refund" | "credit";

export type AgreementLine = ValuedLine & {
  /** This line's share of what we owe the customer, in tender cents. */
  readonly payCents: number;
  /** This line's share of what Stripe charged; CAMBIO lines only. */
  readonly stripeFundedCents: number;
};

export type Agreement = {
  readonly tender: Tender;
  readonly returnLegCents: number;
  readonly outboundLegCents: number;
  /** The fee actually taken: a self-booked return pays the outbound leg only. */
  readonly chargedFeeCents: number;
  readonly returnedValueCents: number;
  readonly replacementValueCents: number;
  /** returned − replacement − charged fee. Positive: we owe the customer. */
  readonly netCents: number;
  readonly stripeChargeCents: number;
  /** A shortfall under Stripe's minimum, not collected. */
  readonly waivedCents: number;
  /** What we owe, in tender cents (credit already at 115%). */
  readonly owedCents: number;
  /** owed − Σ line pay: the indivisible cents, owed by the submission itself. */
  readonly residualCents: number;
  readonly lines: readonly AgreementLine[];
};

/**
 * Cash cents → store-credit cents at 115%, rounded half up. Integer arithmetic,
 * so a value like 1.15 × 0.30 cannot come out as 0.34499….
 */
export function creditTotal(netCents: number): number {
  return Math.floor((netCents * CREDIT_PERCENT + 50) / 100);
}

/**
 * Split `total` across `weights` in proportion, each share rounded DOWN.
 * Whatever is left over is returned as the residual and is never handed to a
 * line, so no line's money depends on its position.
 */
export function splitProportionally(
  total: number,
  weights: readonly number[]
): { shares: number[]; residual: number } {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) {
    return { shares: weights.map(() => 0), residual: Math.max(0, total) };
  }
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  return { shares, residual: total - shares.reduce((a, b) => a + b, 0) };
}

export function buildAgreement(input: {
  lines: readonly ValuedLine[];
  returnLegCents: number;
  outboundLegCents: number;
  /** resolveFee's feeCents: both legs, before the self-booked subtraction. */
  feeCents: number;
  selfBooked: boolean;
  tender: Tender;
}): Agreement {
  const { lines, tender } = input;
  const chargedFeeCents = input.selfBooked ? input.outboundLegCents : input.feeCents;
  const returnedValueCents = lines.reduce((s, l) => s + l.returnedCents, 0);
  const replacementValueCents = lines.reduce((s, l) => s + l.replacementCents, 0);
  const netCents = returnedValueCents - replacementValueCents - chargedFeeCents;

  const shortfall = netCents < 0 ? -netCents : 0;
  const stripeChargeCents = shortfall >= STRIPE_MINIMUM_CENTS ? shortfall : 0;
  const waivedCents = shortfall - stripeChargeCents;

  const owedCents =
    netCents > 0 ? (tender === "credit" ? creditTotal(netCents) : netCents) : 0;

  // Owed money is shared by EVERY returned line, exchanged ones included: a
  // cheaper swap is owed its difference (Santi, 30 Oct).
  const pay = splitProportionally(
    owedCents,
    lines.map((l) => l.returnedCents)
  );
  // What Stripe took funds the replacements, in proportion to their price.
  // Its leftover cents stay with the submission's own stripe_charge_cents.
  const funded = splitProportionally(
    stripeChargeCents,
    lines.map((l) => l.replacementCents)
  );

  return {
    tender,
    returnLegCents: input.returnLegCents,
    outboundLegCents: input.outboundLegCents,
    chargedFeeCents,
    returnedValueCents,
    replacementValueCents,
    netCents,
    stripeChargeCents,
    waivedCents,
    owedCents,
    residualCents: pay.residual,
    lines: lines.map((line, i) => ({
      ...line,
      payCents: pay.shares[i],
      stripeFundedCents: funded.shares[i],
    })),
  };
}

/**
 * The single number the portal shows as the total, in euros: what the
 * customer gets back (in tender units) when positive, what they pay when
 * negative. Credit applies only to money coming BACK — it never inflates a
 * charge, which the old `totalPrice * 1.15` did on a negative total.
 */
export function shownTotalEuros(agreement: Agreement): number {
  return agreement.netCents > 0
    ? agreement.owedCents / 100
    : agreement.netCents / 100;
}
