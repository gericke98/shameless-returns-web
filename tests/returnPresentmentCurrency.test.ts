import { describe, expect, it } from "vitest";
import { buildReturnInput, presentmentRateFromOrder } from "@/lib/returnPayload";

// Order #310741. A US customer paid 34.96 EUR for an exchange on 2026-08-03 and
// received nothing: no Shopify return, no Amphora collection, no email, and a
// portal that asked her to pay a second time.
//
// `returnShippingFee.amount` is documented as "the value of the fee as a fixed
// amount in the PRESENTMENT currency of the order", and the payload hardcoded
// EUR. Her order is shop-currency EUR but presented in USD, so `returnCreate`
// rejected the whole mutation:
//
//   "The presentment currency of the order needs to be used."
//
// Verified against the live order with the read-only `returnCalculate` query:
// 34.96 EUR was refused, 34.96 USD was accepted, and 0.00 EUR was refused too —
// so this broke FREE returns from those countries as well, not just paid ones.
//
// `updateFinalOrder` turns that rejection into a throw, the Stripe webhook
// catches it and reverts, and the customer is left paid-up with nothing. Every
// non-EUR-presentment order in the table (3 US, 1 CZ, 1 IL) has never once
// produced a Shopify return; every EUR order has.

/** #310741 as Shopify returns it: charged in EUR, shown to her in USD. */
const USD_PRESENTED = {
  shop_money: { amount: "92.25", currency_code: "EUR" },
  presentment_money: { amount: "105.00", currency_code: "USD" },
};

/** A domestic order: presentment and shop currency are the same. */
const EUR_PRESENTED = {
  shop_money: { amount: "92.25", currency_code: "EUR" },
  presentment_money: { amount: "92.25", currency_code: "EUR" },
};

const line = {
  variant_id: "55904239812934",
  fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/19590829408582",
  quantity: 1,
  action: "CAMBIO",
  reason: "TOO_SMALL",
  notes: "",
  new_variant_id: "55904239845702",
};

describe("presentmentRateFromOrder", () => {
  it("reads the order's own exchange rate", () => {
    // 105.00 USD / 92.25 EUR. Taken from the order rather than a live FX feed:
    // the return is bookkeeping ON that order, so it has to agree with what the
    // customer was actually shown.
    const rate = presentmentRateFromOrder(USD_PRESENTED);
    expect(rate.currencyCode).toBe("USD");
    expect(rate.rate).toBeCloseTo(105.0 / 92.25, 10);
  });

  it("is a no-op for an order presented in the shop currency", () => {
    expect(presentmentRateFromOrder(EUR_PRESENTED)).toEqual({
      currencyCode: "EUR",
      rate: 1,
    });
  });

  it("falls back to EUR at par when the money set is missing or degenerate", () => {
    // Never throw and never divide by zero here: this runs inside the Stripe
    // webhook, after the customer's card has been charged.
    for (const bad of [
      undefined,
      null,
      {},
      { shop_money: { amount: "0.00", currency_code: "EUR" }, presentment_money: { amount: "105.00", currency_code: "USD" } },
      { shop_money: { amount: "92.25", currency_code: "EUR" }, presentment_money: { amount: "abc", currency_code: "USD" } },
    ]) {
      expect(presentmentRateFromOrder(bad as any)).toEqual({
        currencyCode: "EUR",
        rate: 1,
      });
    }
  });
});

describe("buildReturnInput presentment currency", () => {
  it("converts the EUR fee into the order's presentment currency", () => {
    const input = buildReturnInput("13158935429446", [line], 34.96, {
      includeExchangeItems: false,
      presentment: presentmentRateFromOrder(USD_PRESENTED),
    });

    // 34.96 * (105.00 / 92.25) = 39.7926... -> 39.79
    expect(input.returnShippingFee).toEqual({
      amount: { amount: "39.79", currencyCode: "USD" },
    });
  });

  it("leaves a EUR-presented order exactly as it was", () => {
    // The ~60 Eurozone returns that already work must not move by a cent.
    const input = buildReturnInput("13158935429446", [line], 5, {
      includeExchangeItems: false,
      presentment: presentmentRateFromOrder(EUR_PRESENTED),
    });
    expect(input.returnShippingFee).toEqual({
      amount: { amount: "5.00", currencyCode: "EUR" },
    });
  });

  it("defaults to EUR at par when no presentment is supplied", () => {
    const input = buildReturnInput("13158935429446", [line], 5, {
      includeExchangeItems: false,
    });
    expect(input.returnShippingFee).toEqual({
      amount: { amount: "5.00", currencyCode: "EUR" },
    });
  });

  it("still converts a zero fee, because a free return is rejected too", () => {
    // 0.00 EUR was refused by returnCalculate on #310741 just as 34.96 EUR was:
    // it is the CURRENCY that is validated, not the amount.
    const input = buildReturnInput("13158935429446", [line], 0, {
      includeExchangeItems: false,
      presentment: presentmentRateFromOrder(USD_PRESENTED),
    });
    expect(input.returnShippingFee).toEqual({
      amount: { amount: "0.00", currencyCode: "USD" },
    });
  });
});
