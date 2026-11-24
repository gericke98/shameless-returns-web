import { describe, expect, it } from "vitest";
import { selectionTerms, tenderFromIsCredit, type ValuedBasket } from "@/lib/selectionTerms";
import { sameZone, UNBOUNDED_MAX_GRAMS } from "@/lib/fees";
import type { ValuedLine } from "@/lib/basket";

// Spain-like: return €5.00, exchange €7.00 (so the outbound leg is €2.00).
const legs = sameZone([
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 500, exchangeFeeCents: 700 },
]);

function basket(lines: ValuedLine[]): ValuedBasket {
  const returned = lines.reduce((s, l) => s + l.returnedCents, 0);
  const replacement = lines.reduce((s, l) => s + l.replacementCents, 0);
  return {
    returnPrice: returned / 100,
    exchangePrice: replacement / 100,
    netAmount: (returned - replacement) / 100,
    netCents: returned - replacement,
    lines,
    hasItems: lines.length > 0,
    grams: 400,
    degraded: false,
  };
}
const ret = (cents: number): ValuedLine => ({
  id: 1, action: "DEVOLUCIÓN", quantity: 1, returnedCents: cents, replacementCents: 0, degraded: false,
});
const swap = (cents: number, replacement: number): ValuedLine => ({
  id: 2, action: "CAMBIO", quantity: 1, returnedCents: cents, replacementCents: replacement, degraded: false,
});

describe("selectionTerms", () => {
  it("a €28 return owes €23 back, so a payout is required and no agreement exists until it is chosen", () => {
    const t = selectionTerms(basket([ret(2800)]), legs, "CORREOS", null);
    expect(t.netCents).toBe(2300);
    expect(t.payoutRequired).toBe(true);
    expect(t.agreement).toBeNull();
  });

  it("agrees terms in the tender actually chosen", () => {
    const refund = selectionTerms(basket([ret(2800)]), legs, "CORREOS", "refund");
    const credit = selectionTerms(basket([ret(2800)]), legs, "CORREOS", "credit");
    expect(refund.agreement?.tender).toBe("refund");
    expect(refund.agreement?.owedCents).toBe(2300);
    expect(credit.agreement?.tender).toBe("credit");
    expect(credit.agreement?.owedCents).toBe(2645);
  });

  it("an even swap owes nothing back: no payout, and the agreement exists without a choice", () => {
    const t = selectionTerms(basket([swap(3000, 3000)]), legs, "CORREOS", null);
    expect(t.payoutRequired).toBe(false);
    expect(t.agreement).not.toBeNull();
    expect(t.agreement?.stripeChargeCents).toBe(700);
  });

  // The second route to the #312875 crash: the method changes whether money
  // comes back. calculatePrices ignored it; this does not.
  it("self-booking drops the return leg and can turn 'nothing back' into 'money back'", () => {
    // €3 cheaper swap: worth €3 back before the fee, so Rule A charges the
    // €5 return fee, which is all return leg.
    const b = basket([swap(3000, 2700)]);
    const ours = selectionTerms(b, legs, "CORREOS", null);
    const self = selectionTerms(b, legs, "SELF", null);
    expect(ours.netCents).toBe(-200);
    expect(ours.payoutRequired).toBe(false);
    expect(self.netCents).toBe(300); // their own courier: no leg charged
    expect(self.payoutRequired).toBe(true);
    expect(self.agreement).toBeNull();
  });

  it("an empty basket has no fee and nothing to choose", () => {
    const t = selectionTerms(basket([]), legs, "CORREOS", null);
    expect(t.fee.feeCents).toBe(0);
    expect(t.payoutRequired).toBe(false);
  });
});

describe("tenderFromIsCredit", () => {
  it("never defaults a missing choice", () => {
    expect(tenderFromIsCredit(null)).toBeNull();
    expect(tenderFromIsCredit(true)).toBe("credit");
    expect(tenderFromIsCredit(false)).toBe("refund");
  });
});
