import { describe, expect, it } from "vitest";
import {
  BUNDLED_FEE_LABEL,
  classifyResidual,
  classifySessionLines,
  EXCHANGE_FEE_MODEL_CUTOVER_UNIX,
  isAllSameProductExchange,
  isMixedSameProductExchange,
  isReconstructionSound,
  ISRAEL_REPRICE_CUTOVER_UNIX,
  reconstructBasketFromLines,
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

// R20: the 4 orders excluded by isAllSameProductExchange but which still
// hold a same-product swap line — precisely the shape the pre-branch
// applyGlobalDiscount ratio bug needed to mis-price a same-product line
// using a ratio borrowed from a DIFFERENT, non-same-product line.
describe("isMixedSameProductExchange", () => {
  it("is false when there are no swap lines", () => {
    const index = { productOf: () => "P1" };
    expect(isMixedSameProductExchange([], index)).toBe(false);
  });

  it("is false when ALL swap lines are same-product (that's isAllSameProductExchange's case, not mixed)", () => {
    const swaps: SwapLine[] = [
      { action: "CAMBIO", new_variant_id: "v1", productId: "P1" },
      { action: "CAMBIO", new_variant_id: "v2", productId: "P2" },
    ];
    const index = {
      productOf: (id: string | null | undefined) =>
        id === "v1" ? "P1" : id === "v2" ? "P2" : null,
    };
    expect(isMixedSameProductExchange(swaps, index)).toBe(false);
  });

  it("is false when NO swap line is same-product (nothing to salvage)", () => {
    const swaps: SwapLine[] = [
      { action: "CAMBIO", new_variant_id: "v1", productId: "P1" },
    ];
    const index = { productOf: () => "SOMETHING-ELSE" };
    expect(isMixedSameProductExchange(swaps, index)).toBe(false);
  });

  it("is true when at least one but not all swap lines are same-product", () => {
    const swaps: SwapLine[] = [
      { action: "CAMBIO", new_variant_id: "v1", productId: "P1" }, // same
      { action: "CAMBIO", new_variant_id: "v2", productId: "P1" }, // different
    ];
    const index = {
      productOf: (id: string | null | undefined) =>
        id === "v1" ? "P1" : id === "v2" ? "P2" : null,
    };
    expect(isMixedSameProductExchange(swaps, index)).toBe(true);
  });

  it("matches order #38625's real shape: 2 of 3 swap lines same-product", () => {
    const swaps: SwapLine[] = [
      { action: "CAMBIO", new_variant_id: "v1", productId: "P1" },
      { action: "CAMBIO", new_variant_id: "v2", productId: "P1" },
      { action: "CAMBIO", new_variant_id: "v3", productId: "P2" },
    ];
    const index = {
      productOf: (id: string | null | undefined) =>
        id === "v1" || id === "v2" ? "P1" : id === "v3" ? "P3" : null,
    };
    expect(isMixedSameProductExchange(swaps, index)).toBe(true);
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

// --- R19: reconstructing the bundled pre-itemisation fee -------------------

describe("reconstructBasketFromLines", () => {
  it("nets to zero for a pure same-product CAMBIO (price cancels against itself)", () => {
    const result = reconstructBasketFromLines(
      [{ action: "CAMBIO", price: "39.90", quantity: 1 }],
      500
    );
    expect(result).toEqual({ hasItems: true, netAmount: 0, grams: 500 });
  });

  it("sums grams by quantity, at the fallback weight per unit — never a real catalogue weight", () => {
    const result = reconstructBasketFromLines(
      [
        { action: "CAMBIO", price: "39.90", quantity: 2 },
        { action: "CAMBIO", price: "59.90", quantity: 1 },
      ],
      500
    );
    // 2 units + 1 unit = 3 units, all at the historical 500g fallback.
    expect(result.grams).toBe(1500);
    expect(result.netAmount).toBe(0);
  });

  it("a bundled plain-return (DEVOLUCIÓN) line makes netAmount positive, flipping Rule A to 'return'", () => {
    const result = reconstructBasketFromLines(
      [
        { action: "CAMBIO", price: "39.90", quantity: 1 },
        { action: "DEVOLUCIÓN", price: "25.00", quantity: 1 },
      ],
      500
    );
    // The CAMBIO line cancels (same product, paid price both sides); only
    // the DEVOLUCIÓN line's price survives into netAmount.
    expect(result.netAmount).toBeCloseTo(25, 9);
    expect(result.hasItems).toBe(true);
  });

  it("ignores rows with no action at all (never selected for this return)", () => {
    const result = reconstructBasketFromLines(
      [
        { action: "CAMBIO", price: "39.90", quantity: 1 },
        { action: null, price: "59.90", quantity: 1 },
      ],
      500
    );
    expect(result.grams).toBe(500);
    expect(result.hasItems).toBe(true);
  });

  it("reports hasItems: false and zero grams for an order with no active lines", () => {
    const result = reconstructBasketFromLines(
      [{ action: null, price: "39.90", quantity: 1 }],
      500
    );
    expect(result).toEqual({ hasItems: false, netAmount: 0, grams: 0 });
  });
});

describe("isReconstructionSound", () => {
  const BEFORE_A = EXCHANGE_FEE_MODEL_CUTOVER_UNIX - 1;
  const AFTER_A_BEFORE_B = EXCHANGE_FEE_MODEL_CUTOVER_UNIX + 1;
  const AFTER_B = ISRAEL_REPRICE_CUTOVER_UNIX + 1;

  it("is unsound before the exchange-fee-model cutover, for any zone", () => {
    expect(
      isReconstructionSound({
        sessionCreatedUnix: BEFORE_A,
        zone: "FR",
        usedFallbackZone: false,
      })
    ).toBe(false);
  });

  it("is sound after the cutover for an ordinary, non-Israel, non-fallback zone", () => {
    expect(
      isReconstructionSound({
        sessionCreatedUnix: AFTER_A_BEFORE_B,
        zone: "FR",
        usedFallbackZone: false,
      })
    ).toBe(true);
  });

  it("is unsound for Israel in the gap between the two cutovers", () => {
    expect(
      isReconstructionSound({
        sessionCreatedUnix: AFTER_A_BEFORE_B,
        zone: "IL",
        usedFallbackZone: false,
      })
    ).toBe(false);
  });

  it("is unsound for a '*'-fallback zone in the gap (the fallback moved with Israel)", () => {
    expect(
      isReconstructionSound({
        sessionCreatedUnix: AFTER_A_BEFORE_B,
        zone: null,
        usedFallbackZone: true,
      })
    ).toBe(false);
  });

  it("is sound for Israel once past the Israel-repricing cutover too", () => {
    expect(
      isReconstructionSound({
        sessionCreatedUnix: AFTER_B,
        zone: "IL",
        usedFallbackZone: false,
      })
    ).toBe(true);
  });
});

describe("classifyResidual", () => {
  it("flags an overcharge when the bundled amount exceeds the expected fee by more than a cent", () => {
    const result = classifyResidual(2500, 1100);
    expect(result).toEqual({ status: "reconstructed", residualCents: 1400 });
  });

  it("calls an exact match reconstructed-clean", () => {
    const result = classifyResidual(1100, 1100);
    expect(result).toEqual({ status: "reconstructed-clean", residualCents: 0 });
  });

  it("tolerates a one-cent residual either way as reconstructed-clean (float/rounding slack)", () => {
    expect(classifyResidual(1101, 1100).status).toBe("reconstructed-clean");
    expect(classifyResidual(1099, 1100).status).toBe("reconstructed-clean");
  });

  it("reports an undercharge distinctly — never folded into 'clean' or 'reconstructed'", () => {
    const result = classifyResidual(900, 1100);
    expect(result).toEqual({
      status: "reconstructed-undercharged",
      residualCents: -200,
    });
  });
});
