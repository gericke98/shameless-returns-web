import { describe, expect, it } from "vitest";
import { refundTransactionAmount } from "@/lib/returnPayload";

// Order #311531. A GB customer's return has never been paid, and never could
// be: `createRefund` hardcoded `currencyCode: "EUR"` in the `returnRefund`
// payload, and Shopify validates that amount against the order's PRESENTMENT
// currency:
//
//   "The presentment currency of the order needs to be used."
//
// Her order is shop-currency EUR (67.98) presented in GBP (58.35), so every
// nightly auto-approve run rejected it and always would have. This is the same
// defect the `returnCreate` payload had (see returnPresentmentCurrency.test.ts),
// fixed there in August and missed here because the two payloads are built in
// different files.
//
// The fix reuses the SAME stamped rate: presentment / shop, read off the order
// Shopify recorded at purchase time. Never a live FX lookup, so a refund
// reissued next month cannot drift from the one issued today.

/** #311531 as Shopify returns it: charged in EUR, shown to her in GBP. */
const GBP_PRESENTED = {
  shop_money: { amount: "67.98", currency_code: "EUR" },
  presentment_money: { amount: "58.35", currency_code: "GBP" },
};

/** A domestic order: presentment and shop currency are the same. */
const EUR_PRESENTED = {
  shop_money: { amount: "64.55", currency_code: "EUR" },
  presentment_money: { amount: "64.55", currency_code: "EUR" },
};

describe("refundTransactionAmount", () => {
  it("pays a GBP-presented order in GBP, converted at the stamped rate", () => {
    // 51.45 EUR × (58.35 / 67.98) = 44.16 GBP
    expect(refundTransactionAmount(51.45, GBP_PRESENTED)).toEqual({
      amount: "44.16",
      currencyCode: "GBP",
    });
  });

  it("leaves a domestic EUR order byte-for-byte as it behaves today", () => {
    expect(refundTransactionAmount(51.05, EUR_PRESENTED)).toEqual({
      amount: "51.05",
      currencyCode: "EUR",
    });
  });

  // The refund runs after the customer is already owed money. A missing or
  // malformed money set must not throw and must not invent a currency: it
  // degrades to the behaviour every Eurozone order already has.
  it("degrades to EUR at par when the money set is missing", () => {
    expect(refundTransactionAmount(34.5, null)).toEqual({
      amount: "34.50",
      currencyCode: "EUR",
    });
  });

  it("degrades to EUR at par when the shop amount is zero or unparseable", () => {
    expect(
      refundTransactionAmount(34.5, {
        shop_money: { amount: "0.00", currency_code: "EUR" },
        presentment_money: { amount: "40.00", currency_code: "USD" },
      })
    ).toEqual({ amount: "34.50", currencyCode: "EUR" });
  });

  it("rounds to two decimals, because Shopify rejects more", () => {
    // 10.00 EUR × (58.35 / 67.98) = 8.5834... → 8.58
    expect(refundTransactionAmount(10, GBP_PRESENTED).amount).toBe("8.58");
  });
});
