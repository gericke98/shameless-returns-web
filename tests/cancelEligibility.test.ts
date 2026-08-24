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

describe("self-booked returns before the parcel is posted", () => {
  const selfReturn = (over: Record<string, any> = {}) => ({
    products: [{ confirmed: true, refunded: false }],
    returnStatus: null,
    returnMethod: "SELF",
    locator: null,
    ...over,
  });

  it("is cancellable while no tracking exists", () => {
    // Nothing has been booked and nothing posted — strictly safer than a
    // domestic return with a live Correos label, which is already allowed.
    // Without this the customer hits carrier-unreadable and is trapped.
    expect(cancelEligibility(selfReturn(), "unreadable")).toEqual({
      cancellable: true,
    });
  });

  it("blocks once tracking exists — the parcel is presumed in the network", () => {
    // "not-moved" with a non-Correos carrier is the REACHABLE state here, and
    // the one that used to let a posted parcel be cancelled and refunded:
    // `readCarrierMovement` short-circuits to "not-moved" for any carrier that
    // is not Correos, without a network call, and the Amphora `returnStatus`
    // that is supposed to cover those never advances in time for a SELF
    // return — domestic rows are skipped by the sync, international ones sit
    // at APROVED until the parcel lands.
    //
    // This case previously passed `movement: "unreadable"`, which
    // `readCarrierMovement` can never return for this row shape, so it was
    // green for the wrong reason and hid the defect.
    const posted = selfReturn({ locator: "JD0123456789", carrier: "SEUR" });

    expect(cancelEligibility(posted, "not-moved")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });

  it("blocks a posted international self-booked return still sitting at APROVED", () => {
    // APROVED is deliberately NOT in MOVED_STATUSES — Amphora only advances to
    // TRAVELLING once the parcel physically arrives, i.e. after the window in
    // which cancelling would be a mistake has already closed.
    const posted = selfReturn({
      locator: "1Z999AA10123456784",
      carrier: "UPS",
      returnStatus: "APROVED",
    });

    expect(cancelEligibility(posted, "not-moved")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });

  it("still blocks a settled self-booked return", () => {
    // Money already moved; the lane does not change that.
    const settled = selfReturn({
      products: [{ confirmed: true, refunded: true }],
    });

    expect(cancelEligibility(settled, "unreadable")).toEqual({
      cancellable: false,
      reason: "already-settled",
    });
  });

  it("still blocks when Amphora says the parcel moved", () => {
    const moved = selfReturn({ returnStatus: "RECEIVED" });

    expect(cancelEligibility(moved, "unreadable")).toEqual({
      cancellable: false,
      reason: "in-transit",
    });
  });
});
