import { describe, expect, it } from "vitest";
import { cancelEligibility } from "@/lib/cancelEligibility";

// When a customer may cancel their own return. Four signals block; anything
// else is allowed. Pure, so the whole matrix is cheap to state.

const confirmed = (extra: Record<string, unknown> = {}) => ({
  products: [{ confirmed: true, refunded: false }],
  returnStatus: null,
  ...extra,
});

describe("cancelEligibility", () => {
  it("allows cancelling a fresh return whose parcel has not moved", () => {
    expect(cancelEligibility(confirmed(), "not-moved")).toEqual({ cancellable: true });
  });

  it("refuses when there is no return at all", () => {
    expect(cancelEligibility({ products: [{ confirmed: false }] }, "not-moved")).toEqual({
      cancellable: false,
      reason: "no-return",
    });
  });

  it("refuses when the order cannot be read", () => {
    expect(cancelEligibility(null, "not-moved")).toEqual({
      cancellable: false,
      reason: "no-return",
    });
  });

  it("refuses once an admin has settled a line", () => {
    // validateReturn set this: a refund was issued, a gift card minted, or the
    // replacement exchange order created.
    const order = { products: [{ confirmed: true, refunded: true }], returnStatus: null };
    expect(cancelEligibility(order, "not-moved")).toEqual({
      cancellable: false,
      reason: "already-settled",
    });
  });

  it("refuses once the parcel is with the carrier", () => {
    expect(cancelEligibility(confirmed(), "moved")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });

  it("refuses when we cannot reach the carrier", () => {
    // Fails closed. Blocking costs an email; allowing costs the refund and the
    // garment.
    expect(cancelEligibility(confirmed(), "unreadable")).toEqual({
      cancellable: false,
      reason: "carrier-unreadable",
    });
  });

  it.each(["PENDING", "APROVED", null, undefined])(
    "allows cancelling while Amphora status is %s",
    (returnStatus) => {
      expect(cancelEligibility(confirmed({ returnStatus }), "not-moved")).toEqual({
        cancellable: true,
      });
    }
  );

  it.each([
    "TRAVELLING",
    "PROCESSING_WAREHOUSE",
    "RECEIVED",
    "FINISHED",
    "FINISHED_REJECTED",
    "EXCEPTION",
    "EXCEPTION_WAREHOUSE",
  ])("refuses once Amphora reports %s", (returnStatus) => {
    expect(cancelEligibility(confirmed({ returnStatus }), "not-moved")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });

  it("checks settlement before movement, so a settled return reads as settled", () => {
    const order = { products: [{ confirmed: true, refunded: true }], returnStatus: "RECEIVED" };
    expect(cancelEligibility(order, "moved")).toEqual({
      cancellable: false,
      reason: "already-settled",
    });
  });
});
