import { describe, expect, it } from "vitest";
import { returnOutcome } from "@/lib/returnOutcome";

// `returnFunction` redirects to /success whether the return succeeded, failed
// or threw, so the page cannot trust the fact that it was reached. Order
// #310185 was reverted and still landed here on 2026-08-05; the customer wrote
// in asking what she had done wrong. This decides what she should have seen.

const confirmedLine = { confirmed: true };
const unconfirmedLine = { confirmed: false };

describe("returnOutcome", () => {
  it("confirms a return when a line item is confirmed", () => {
    expect(returnOutcome({ products: [confirmedLine] }).state).toBe("confirmed");
  });

  it("reports missing when the order has no confirmed line", () => {
    // The revert clears `confirmed`, so this is exactly the reverted return.
    expect(returnOutcome({ products: [unconfirmedLine] }).state).toBe("missing");
  });

  it("reports missing when the order has no lines at all", () => {
    expect(returnOutcome({ products: [] }).state).toBe("missing");
  });

  it("confirms when only one line of several is confirmed", () => {
    expect(
      returnOutcome({ products: [unconfirmedLine, confirmedLine] }).state
    ).toBe("confirmed");
  });

  // The trap this whole module has to avoid. An international return Amphora
  // has not assigned a carrier to has a null locator and is entirely real —
  // testing tracking instead of `confirmed` would have called all seven of the
  // August stranded returns failures.
  it("confirms a return that has no tracking yet", () => {
    const outcome = returnOutcome({ products: [confirmedLine], locator: null });
    expect(outcome.state).toBe("confirmed");
    expect(outcome.tracking).toBeNull();
  });

  it("carries the tracking through when there is some", () => {
    const outcome = returnOutcome({
      products: [confirmedLine],
      locator: "JJD00026866036667489001",
      carrier: "DHP",
      carrierUrl: "https://clientesparcel.dhl.es/x",
    });
    expect(outcome.tracking).toEqual({
      locator: "JJD00026866036667489001",
      carrier: "DHP",
      carrierUrl: "https://clientesparcel.dhl.es/x",
    });
  });

  it("carries a bare Correos locator with no carrier or url", () => {
    // Domestic labels give us a tracking number and nothing else.
    const outcome = returnOutcome({
      products: [confirmedLine],
      locator: "PQ123456789ES",
    });
    expect(outcome.tracking).toEqual({
      locator: "PQ123456789ES",
      carrier: null,
      carrierUrl: null,
    });
  });

  // Never claim a failure we cannot prove. The session TTL is two hours and a
  // slow Stripe checkout can outlive it.
  it("is unknown when there is no order to look at", () => {
    expect(returnOutcome(null).state).toBe("unknown");
    expect(returnOutcome(undefined).state).toBe("unknown");
  });

  it("is unknown when the order carries no line items to judge", () => {
    // `products` absent entirely is a shape we cannot read, unlike an empty
    // array, which genuinely says "nothing was confirmed".
    expect(returnOutcome({}).state).toBe("unknown");
  });
});
