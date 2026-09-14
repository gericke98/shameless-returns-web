import { describe, expect, it } from "vitest";
import {
  pickRefundTransaction,
  type ShopifyTransaction,
} from "@/lib/refundTransaction";

/** Shape Shopify returns from `order { transactions { ... } }`. */
function tx(
  id: string,
  amount: string,
  status: string,
  kind = "SALE"
): ShopifyTransaction {
  return { id, kind, status, amountSet: { shopMoney: { amount } } };
}

describe("pickRefundTransaction", () => {
  // The bug that stranded #311882: the customer's first payment attempt
  // FAILED and they paid again the next day. `transactions[0]` is the dead
  // attempt, and `returnRefund` against it fails with "All transactions
  // failed to be refunded" — every morning, forever.
  it("skips a failed first attempt and picks the successful retry", () => {
    const picked = pickRefundTransaction([
      tx("gid://shopify/OrderTransaction/14921336979782", "136.0", "FAILURE"),
      tx("gid://shopify/OrderTransaction/14925389824326", "129.2", "SUCCESS"),
    ]);

    expect(picked?.id).toBe("gid://shopify/OrderTransaction/14925389824326");
  });

  it("picks the largest successful sale when several exist", () => {
    const picked = pickRefundTransaction([
      tx("small", "10.00", "SUCCESS"),
      tx("large", "120.00", "SUCCESS"),
      tx("middle", "45.00", "SUCCESS"),
    ]);

    expect(picked?.id).toBe("large");
  });

  it("accepts a CAPTURE as well as a SALE", () => {
    const picked = pickRefundTransaction([tx("cap", "80.00", "SUCCESS", "CAPTURE")]);

    expect(picked?.id).toBe("cap");
  });

  // A REFUND transaction is money going the other way and an AUTHORIZATION
  // never took any. Naming either as the parent of a refund is meaningless.
  it("ignores kinds that never received money", () => {
    const picked = pickRefundTransaction([
      tx("auth", "200.00", "SUCCESS", "AUTHORIZATION"),
      tx("refund", "50.00", "SUCCESS", "REFUND"),
      tx("void", "200.00", "SUCCESS", "VOID"),
      tx("sale", "30.00", "SUCCESS"),
    ]);

    expect(picked?.id).toBe("sale");
  });

  // Refusing is the whole point: a null here must stop the settlement rather
  // than send an empty id to Shopify and let it fail deep in the money path.
  it("returns null when no transaction ever succeeded", () => {
    expect(
      pickRefundTransaction([
        tx("a", "42.90", "FAILURE"),
        tx("b", "42.90", "ERROR"),
      ])
    ).toBeNull();
  });

  it("returns null for an order with no transactions at all", () => {
    expect(pickRefundTransaction([])).toBeNull();
    expect(pickRefundTransaction(null)).toBeNull();
    expect(pickRefundTransaction(undefined)).toBeNull();
  });

  // Shopify sends amounts as strings. Sorting them as strings puts "9.00"
  // above "120.00", which would hand back the smaller transaction.
  it("compares amounts numerically, not as strings", () => {
    const picked = pickRefundTransaction([
      tx("nine", "9.00", "SUCCESS"),
      tx("onetwenty", "120.00", "SUCCESS"),
    ]);

    expect(picked?.id).toBe("onetwenty");
  });

  // An unparseable or missing amount must never win the sort and so be
  // returned as the refund target.
  it("prefers a readable amount over a missing one", () => {
    const picked = pickRefundTransaction([
      { id: "noamount", kind: "SALE", status: "SUCCESS" },
      tx("real", "15.00", "SUCCESS"),
    ]);

    expect(picked?.id).toBe("real");
  });

  it("treats status and kind case-insensitively", () => {
    const picked = pickRefundTransaction([tx("lower", "20.00", "success", "sale")]);

    expect(picked?.id).toBe("lower");
  });
});
