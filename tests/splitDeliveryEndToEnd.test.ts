import { describe, expect, it } from "vitest";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { resolveFee, checkoutLines, centsToEuros, DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";
import { deliveryAddressOf, hasSeparateDelivery } from "@/lib/deliveryAddress";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  US: flat(2200, 3496),
};

/** The whole journey: what the form submits -> what is stored -> what is charged. */
describe("Spain collection, US delivery", () => {
  const submitted = {
    deliveryName: "Ana Ruiz",
    deliveryAddress1: "120 Broadway",
    deliveryAddress2: "Apt 4",
    deliveryZip: "10271",
    deliveryCity: "New York",
    deliveryProvince: "NY",
    deliveryCountry: "US",
  };

  it("carries the form through storage to the charge", () => {
    const parsed = parseDeliveryInput(submitted);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok || !parsed.value) throw new Error("unreachable");

    // What updateData would write.
    const stored = {
      shippingName: "Ana Ruiz",
      shippingAddress1: "Calle Mayor 1",
      shippingAddress2: null,
      shippingZip: "28013",
      shippingCity: "Madrid",
      shippingProvince: "Madrid",
      shippingCountry: "España",
      deliveryName: parsed.value.name,
      deliveryAddress1: parsed.value.address1,
      deliveryAddress2: parsed.value.address2,
      deliveryZip: parsed.value.zip,
      deliveryCity: parsed.value.city,
      deliveryProvince: parsed.value.province,
      deliveryCountry: parsed.value.country,
    } as any;

    expect(hasSeparateDelivery(stored)).toBe(true);
    expect(deliveryAddressOf(stored).country).toBe("US");

    // What createStripeUrl would charge for an even swap.
    const legs = feeLegsForOrder(TABLE, stored);
    const basket = { hasItems: true, netAmount: 0, grams: 500 };
    const { feeCents, returnLegCents, outboundLegCents } = resolveFee(legs, basket);
    expect(returnLegCents).toBe(500);
    expect(outboundLegCents).toBe(1296);
    expect(feeCents).toBe(1796);

    // The Stripe line items must sum to exactly what is charged, or the
    // caller falls back to one opaque line.
    const amountCents = Math.round(-(basket.netAmount - centsToEuros(feeCents)) * 100);
    const lines = checkoutLines(basket, { returnLegCents, outboundLegCents }, amountCents);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(amountCents);
    expect(lines.map((l) => l.kind)).toEqual(["returnShipping", "deliveryShipping"]);
  });

  it("costs the Spanish price when the customer does not ask to redirect it", () => {
    const stored = {
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
    } as any;
    const legs = feeLegsForOrder(TABLE, stored);
    expect(resolveFee(legs, { hasItems: true, netAmount: 0, grams: 500 }).feeCents).toBe(850);
  });
});
