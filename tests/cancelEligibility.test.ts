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

  it("refuses when products key is missing", () => {
    expect(cancelEligibility({}, "not-moved")).toEqual({
      cancellable: false,
      reason: "no-return",
    });
  });

  it("refuses when products is not an array", () => {
    expect(cancelEligibility({ products: "not-an-array" as any }, "not-moved")).toEqual({
      cancellable: false,
      reason: "no-return",
    });
  });

  it("refuses when products is a non-array object", () => {
    expect(cancelEligibility({ products: { confirmed: true } as any }, "not-moved")).toEqual({
      cancellable: false,
      reason: "no-return",
    });
  });

  it("refuses when products is a number", () => {
    expect(cancelEligibility({ products: 123 as any }, "not-moved")).toEqual({
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

  it("ignores a refunded line left over from a previous, already-reset return", () => {
    // `resetOrderReturn` deliberately does NOT clear `refunded` — it is the
    // record that we paid that customer for that garment. But scoping the
    // settlement check to the whole ORDER meant one settled return disabled
    // cancellation on every future return for that customer, forever: they
    // create a return two minutes ago and are told "we've already processed
    // this return". Only lines that belong to the CURRENT return count, and
    // `confirmed` is what says so.
    const order = {
      products: [
        { confirmed: false, refunded: true }, // last month's return, settled and reset
        { confirmed: true, refunded: false }, // the one they just created
      ],
      returnStatus: null,
    };
    expect(cancelEligibility(order, "not-moved")).toEqual({ cancellable: true });
  });

  it("still refuses when the line an admin settled is part of THIS return", () => {
    const order = {
      products: [
        { confirmed: false, refunded: true },
        { confirmed: true, refunded: true },
      ],
      returnStatus: null,
    };
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
