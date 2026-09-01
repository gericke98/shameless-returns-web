import { describe, expect, it } from "vitest";
import { calculatePriceWithDiscount } from "@/utils/order-utils";
import type { OrderLineItem } from "@/types";

const item = (o: Partial<OrderLineItem>) => o as OrderLineItem;

describe("calculatePriceWithDiscount", () => {
  it("returns the unit price when there is no discount", () => {
    expect(
      calculatePriceWithDiscount(item({ price: "55.00", quantity: 1 }))
    ).toBeCloseTo(55.0, 2);
  });

  it("subtracts a single allocation from a single unit", () => {
    expect(
      calculatePriceWithDiscount(
        item({
          price: "55.00",
          quantity: 1,
          discount_allocations: [{ amount: "2.75" }],
        } as Partial<OrderLineItem>)
      )
    ).toBeCloseTo(52.25, 2);
  });

  it("divides a LINE-TOTAL allocation across the quantity", () => {
    // Shopify allocates against the line, not the unit. Two units at EUR 55
    // with a 5% code allocate EUR 5.50 to the line; the unit paid EUR 52.25.
    expect(
      calculatePriceWithDiscount(
        item({
          price: "55.00",
          quantity: 2,
          discount_allocations: [{ amount: "5.50" }],
        } as Partial<OrderLineItem>)
      )
    ).toBeCloseTo(52.25, 2);
  });

  it("sums every allocation, not just the first", () => {
    expect(
      calculatePriceWithDiscount(
        item({
          price: "55.00",
          quantity: 1,
          discount_allocations: [{ amount: "2.75" }, { amount: "5.00" }],
        } as Partial<OrderLineItem>)
      )
    ).toBeCloseTo(47.25, 2);
  });

  it("never returns a negative unit price", () => {
    expect(
      calculatePriceWithDiscount(
        item({
          price: "10.00",
          quantity: 1,
          discount_allocations: [{ amount: "99.00" }],
        } as Partial<OrderLineItem>)
      )
    ).toBe(0);
  });
});
