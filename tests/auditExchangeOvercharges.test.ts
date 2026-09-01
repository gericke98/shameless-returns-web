import { describe, expect, it } from "vitest";
import {
  BUNDLED_FEE_LABEL,
  classifySessionLines,
  isAllSameProductExchange,
  type SwapLine,
} from "@/lib/exchangeOverchargeAudit";

// Pure decision logic only — no network, no db, no Stripe. These are the two
// functions the historical audit's correctness rests on: "is this order
// entirely same-product size swaps?" and "which Stripe line, if any, is the
// price difference?".

describe("isAllSameProductExchange", () => {
  it("is false when there are no CAMBIO+new_variant_id lines at all", () => {
    const index = { productOf: () => "P1" };
    expect(isAllSameProductExchange([], index)).toBe(false);
  });

  it("is true when every chosen replacement belongs to its own line's product", () => {
    const swaps: SwapLine[] = [
      { action: "CAMBIO", new_variant_id: "v1", productId: "P1" },
      { action: "CAMBIO", new_variant_id: "v2", productId: "P2" },
    ];
    const index = {
      productOf: (id: string | null | undefined) =>
        id === "v1" ? "P1" : id === "v2" ? "P2" : null,
    };
    expect(isAllSameProductExchange(swaps, index)).toBe(true);
  });

  it("is false when even one line's replacement is a DIFFERENT product", () => {
    // This is the whole point of the audit: ALL lines must be same-product,
    // not most of them, for the order to owe exactly EUR 0.
    const swaps: SwapLine[] = [
      { action: "CAMBIO", new_variant_id: "v1", productId: "P1" }, // same
      { action: "CAMBIO", new_variant_id: "v2", productId: "P1" }, // different
    ];
    const index = {
      productOf: (id: string | null | undefined) =>
        id === "v1" ? "P1" : id === "v2" ? "P2" : null,
    };
    expect(isAllSameProductExchange(swaps, index)).toBe(false);
  });

  it("is false when the replacement's product cannot be resolved (left the catalogue)", () => {
    const swaps: SwapLine[] = [
      { action: "CAMBIO", new_variant_id: "gone", productId: "P1" },
    ];
    const index = { productOf: () => null };
    expect(isAllSameProductExchange(swaps, index)).toBe(false);
  });
});

describe("classifySessionLines", () => {
  it("finds the EN difference line and reports it exact", () => {
    const result = classifySessionLines([
      { description: "New items", amount_total: 2000 },
      { description: "Return shipping", amount_total: 500 },
    ]);
    expect(result).toEqual({
      status: "exact",
      differenceCents: 2000,
      labels: ["New items", "Return shipping"],
    });
  });

  it("finds the ES difference line and reports it exact", () => {
    const result = classifySessionLines([
      { description: "Nuevos productos", amount_total: 1500 },
      { description: "Envío de devolución", amount_total: 500 },
      { description: "Envío de los nuevos productos", amount_total: 300 },
    ]);
    expect(result.status).toBe("exact");
    expect(result.differenceCents).toBe(1500);
  });

  it("THE TRAP: 'Delivery of new items' is NOT the difference line, even though it contains 'new items'", () => {
    // A substring/negative-regex match would score the outbound shipping leg
    // as a price difference here and invent an overcharge. This is defect 2
    // from task-6-amendment.md.
    const result = classifySessionLines([
      { description: "Return shipping", amount_total: 500 },
      { description: "Delivery of new items", amount_total: 700 },
    ]);
    expect(result.status).toBe("no-charge");
    expect(result.differenceCents).toBeNull();
  });

  it("THE TRAP (ES): 'Envío de los nuevos productos' is not 'Nuevos productos'", () => {
    const result = classifySessionLines([
      { description: "Envío de devolución", amount_total: 500 },
      { description: "Envío de los nuevos productos", amount_total: 700 },
    ]);
    expect(result.status).toBe("no-charge");
    expect(result.differenceCents).toBeNull();
  });

  it("reports the bundled pre-itemisation fee as indeterminate, not exact or dropped", () => {
    const result = classifySessionLines([
      { description: BUNDLED_FEE_LABEL, amount_total: 2500 },
    ]);
    expect(result.status).toBe("indeterminate");
    expect(result.differenceCents).toBeNull();
    expect(result.labels).toEqual([BUNDLED_FEE_LABEL]);
  });

  it("reports no-charge for a paid session with only shipping lines", () => {
    const result = classifySessionLines([
      { description: "Shipping", amount_total: 500 },
    ]);
    expect(result.status).toBe("no-charge");
  });

  it("trims whitespace before matching, but does not match case-insensitively or by substring", () => {
    const result = classifySessionLines([
      { description: "  New items  ", amount_total: 1000 },
    ]);
    expect(result.status).toBe("exact");
    expect(result.differenceCents).toBe(1000);

    const wrongCase = classifySessionLines([
      { description: "new items", amount_total: 1000 },
    ]);
    expect(wrongCase.status).toBe("no-charge");
  });

  it("does not report exact for a zero-amount difference line", () => {
    const result = classifySessionLines([
      { description: "New items", amount_total: 0 },
    ]);
    expect(result.status).toBe("no-charge");
  });
});
