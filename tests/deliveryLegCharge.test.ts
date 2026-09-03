import { describe, expect, it } from "vitest";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { centsToEuros, resolveFee, DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];

/** The real 1 kg rows from data/return-tariff.csv. */
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  US: flat(2200, 3496),
};

function order(over: Record<string, unknown> = {}) {
  return {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: null,
    shippingZip: "28013",
    shippingCity: "Madrid",
    shippingProvince: "Madrid",
    shippingCountry: "España",
    deliveryName: null,
    deliveryAddress1: null,
    deliveryAddress2: null,
    deliveryZip: null,
    deliveryCity: null,
    deliveryProvince: null,
    deliveryCountry: null,
    ...over,
  } as any;
}

const US_DELIVERY = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: null,
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

/** An even swap: same price in, same price out. */
const evenSwap = { hasItems: true, netAmount: 0, grams: 500 };

describe("the charge for a Spain-collected exchange", () => {
  it("is the Spanish exchange fee when the replacement stays in Spain", () => {
    const legs = feeLegsForOrder(TABLE, order());
    expect(resolveFee(legs, evenSwap).feeCents).toBe(850);
  });

  it("adds the US outbound leg when the replacement goes to the US", () => {
    const legs = feeLegsForOrder(TABLE, order(US_DELIVERY));
    const { feeCents, returnLegCents, outboundLegCents } = resolveFee(legs, evenSwap);
    // Collected in Spain at 5.00, delivered to the US at 12.96.
    expect(returnLegCents).toBe(500);
    expect(outboundLegCents).toBe(1296);
    expect(feeCents).toBe(1796);
    expect(centsToEuros(feeCents)).toBe(17.96);
  });

  // The SELF rule is a subtraction, not a second table: a self-booked return
  // pays its own courier for the return leg, but the replacement still travels
  // on our account — now to the US.
  it("bills a self-booked return the US outbound leg alone", () => {
    const legs = feeLegsForOrder(TABLE, order(US_DELIVERY));
    const { outboundLegCents } = resolveFee(legs, evenSwap);
    expect(outboundLegCents).toBe(1296);
  });

  // A pure return has no second journey. A stale delivery address left on the
  // row must not raise the price of a refund.
  it("does not charge the delivery zone on a pure return", () => {
    const legs = feeLegsForOrder(TABLE, order(US_DELIVERY));
    const pureReturn = { hasItems: true, netAmount: 40, grams: 500 };
    expect(resolveFee(legs, pureReturn)).toMatchObject({
      kind: "return",
      feeCents: 500,
      outboundLegCents: 0,
    });
  });
});
