import { beforeEach, describe, expect, it, vi } from "vitest";

// The reversal chain, in order.
//
// Step 1 (Amphora) aborts everything: it is the only booking either lane lets
// us release, and refunding past a failure there leaves the warehouse expecting
// a parcel forever.
//
// Past step 1 the logic inverts. The return is gone and, for Spain, the Correos
// label cannot be voided at all — so the customer is owed their money whatever
// else breaks. Later steps continue and raise a durable alert instead.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const calls = {
  // `getOrderByIdFresh` is the only order read this orchestrator may use — it
  // acts on what it reads, and `getOrderById` is memoized by React `cache()`
  // for a render pass, which can serve a stale snapshot on a warm serverless
  // instance. `memoizedRead` stays empty in every passing test; if the
  // implementation is ever switched back to the cached read, it fills in and
  // the "reads the order fresh" test below fails.
  orderRead: [] as string[],
  memoizedRead: [] as string[],
  carrierRead: [] as string[],
  amphoraCancel: [] as string[],
  shopifyCancel: [] as string[],
  releaseHold: [] as string[],
  refund: [] as string[],
  reset: [] as string[],
  customerEmail: [] as string[],
  opsAlert: [] as string[],
  // One shared log every mocked primitive pushes its own name onto, so the
  // ORDER of the chain is pinned, not just which primitives ran.
  sequence: [] as string[],
};

const behaviour = {
  access: true,
  movement: "not-moved" as "moved" | "not-moved" | "unreadable",
  amphoraFails: false,
  // When amphoraFails is true, the HTTP status the mock's error carries.
  // Undefined mirrors a plain thrown Error with no `.response` at all, which
  // is what the pre-existing tests below expect to stay fatal.
  amphoraFailureStatus: undefined as number | undefined,
  shopifyFails: false,
  releaseFails: false,
  refundOutcome: { refunded: true } as any,
  resetFails: false,
  emailFails: false,
};

const ORDER: Record<string, any> = {};

/** The row as it looks with one live, unsettled return on it. */
function freshOrder(): Record<string, any> {
  return {
    id: "13217168851270",
    orderNumber: "#311148",
    email: "customer@example.com",
    locale: "es",
    locator: "PQ1ES",
    carrier: null,
    returnMethod: "CORREOS",
    returnStatus: "APROVED",
    stripePaymentIntent: "pi_stored",
    products: [{ confirmed: true, refunded: false, return_id: "gid://shopify/Return/1" }],
  };
}

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => behaviour.access }));
vi.mock("@/db/queries", () => ({
  // Present so an accidental revert to the memoized read doesn't crash the
  // module load — it would instead get called and caught by the assertion in
  // "reads the order fresh, not through the memoized cache".
  getOrderById: async (id: string) => {
    calls.memoizedRead.push(id);
    return ORDER;
  },
  getOrderByIdFresh: async (id: string) => {
    calls.orderRead.push(id);
    return ORDER;
  },
  cancelShopifyReturn: async (id: string) => {
    calls.shopifyCancel.push(id);
    calls.sequence.push("shopify");
    return behaviour.shopifyFails ? { success: false, errors: "nope" } : { success: true };
  },
  // Mirrors the real reset (db/queries.ts) against the in-memory row, so a
  // SECOND cancellation of the same order sees what the first one left behind
  // rather than a pristine snapshot. `refunded` is left alone on purpose —
  // that is what the real one does.
  resetOrderReturn: async (id: string) => {
    calls.reset.push(id);
    calls.sequence.push("reset");
    if (behaviour.resetFails) throw new Error("neon: connection terminated");
    ORDER.locator = null;
    ORDER.carrier = null;
    ORDER.carrierUrl = null;
    ORDER.returnStatus = null;
    ORDER.stripePaymentIntent = null;
    ORDER.products = ORDER.products.map((line: any) => ({
      ...line,
      confirmed: false,
      return_id: null,
      return_line_item_id: null,
    }));
  },
}));
vi.mock("@/actions/shipping", () => ({
  readCarrierMovement: async (locator: string | null | undefined, carrier?: string | null) => {
    calls.carrierRead.push(`${locator}/${carrier ?? ""}`);
    return behaviour.movement;
  },
}));
vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  cancelAmphoraReturn: async (id: string) => {
    if (behaviour.amphoraFails) {
      const error: any = new Error("amphora cancel failed");
      if (behaviour.amphoraFailureStatus !== undefined) {
        error.response = { status: behaviour.amphoraFailureStatus };
      }
      throw error;
    }
    calls.amphoraCancel.push(id);
    calls.sequence.push("amphora");
    return { id };
  },
}));
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async (id: string) => {
    calls.releaseHold.push(id);
    calls.sequence.push("release");
    return !behaviour.releaseFails;
  },
}));
vi.mock("@/actions/refundPayment", () => ({
  refundOrderPayment: async (order: any) => {
    calls.refund.push(order.id);
    calls.sequence.push("refund");
    return behaviour.refundOutcome;
  },
}));
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    calls.opsAlert.push(`${subject}::${body}`);
  },
}));
vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) {
        if (behaviour.emailFails) throw new Error("postmark down");
        calls.customerEmail.push(url);
        calls.sequence.push("email");
      }
      return { status: 200 };
    },
  },
}));

async function cancel() {
  const { cancelReturnFunction } = await import("@/actions/cancelReturn");
  return cancelReturnFunction(ORDER.id);
}

beforeEach(() => {
  for (const key of Object.keys(calls)) (calls as any)[key].length = 0;
  behaviour.access = true;
  behaviour.movement = "not-moved";
  behaviour.amphoraFails = false;
  behaviour.amphoraFailureStatus = undefined;
  behaviour.shopifyFails = false;
  behaviour.releaseFails = false;
  behaviour.refundOutcome = { refunded: true };
  behaviour.resetFails = false;
  behaviour.emailFails = false;
  for (const key of Object.keys(ORDER)) delete ORDER[key];
  Object.assign(ORDER, freshOrder());
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("cancelling an eligible return", () => {
  it("reports success", async () => {
    expect(await cancel()).toEqual({ ok: true });
  });

  it("reads the order fresh, not through the memoized cache", async () => {
    await cancel();
    expect(calls.orderRead).toEqual([ORDER.id]);
    expect(calls.memoizedRead).toHaveLength(0);
  });

  it("cancels the Amphora return for that order", async () => {
    await cancel();
    expect(calls.amphoraCancel).toEqual(["SHP 13217168851270"]);
  });

  it("cancels the Shopify return the lines carry", async () => {
    await cancel();
    expect(calls.shopifyCancel).toEqual(["gid://shopify/Return/1"]);
  });

  it("releases the exchange stock hold", async () => {
    await cancel();
    expect(calls.releaseHold).toEqual([ORDER.id]);
  });

  it("refunds the customer", async () => {
    await cancel();
    expect(calls.refund).toEqual([ORDER.id]);
  });

  it("resets the order to a clean slate", async () => {
    await cancel();
    expect(calls.reset).toEqual([ORDER.id]);
  });

  it("emails the customer", async () => {
    await cancel();
    expect(calls.customerEmail).toHaveLength(1);
  });

  it("runs the reversal chain in the exact documented order", async () => {
    await cancel();
    expect(calls.sequence).toEqual([
      "amphora",
      "shopify",
      "release",
      "refund",
      "reset",
      "email",
    ]);
  });
});

describe("when the return may not be cancelled", () => {
  it("refuses a caller with no session, and touches nothing at all", async () => {
    behaviour.access = false;
    expect(await cancel()).toEqual({ ok: false, reason: "forbidden" });
    expect(calls.orderRead).toHaveLength(0);
    expect(calls.memoizedRead).toHaveLength(0);
    expect(calls.carrierRead).toHaveLength(0);
    expect(calls.amphoraCancel).toHaveLength(0);
    expect(calls.shopifyCancel).toHaveLength(0);
    expect(calls.releaseHold).toHaveLength(0);
    expect(calls.refund).toHaveLength(0);
    expect(calls.reset).toHaveLength(0);
    expect(calls.customerEmail).toHaveLength(0);
  });

  it("refuses once the parcel has moved, even if the action is called directly", async () => {
    behaviour.movement = "moved";
    expect(await cancel()).toEqual({ ok: false, reason: "in-transit" });
    expect(calls.refund).toHaveLength(0);
  });

  it("refuses when the carrier cannot be reached", async () => {
    behaviour.movement = "unreadable";
    expect(await cancel()).toEqual({ ok: false, reason: "carrier-unreadable" });
    expect(calls.amphoraCancel).toHaveLength(0);
  });

  it("refuses once an admin has settled it", async () => {
    ORDER.products = [{ confirmed: true, refunded: true, return_id: "gid://shopify/Return/1" }];
    expect(await cancel()).toEqual({ ok: false, reason: "already-settled" });
    expect(calls.refund).toHaveLength(0);
  });
});

describe("when a step fails", () => {
  it("aborts before any money moves if Amphora will not cancel", async () => {
    behaviour.amphoraFails = true;

    expect(await cancel()).toEqual({ ok: false, reason: "carrier-cancel-failed" });
    expect(calls.shopifyCancel).toHaveLength(0);
    expect(calls.refund).toHaveLength(0);
    expect(calls.reset).toHaveLength(0);
  });

  it("still cancels a self-booked return whose Amphora ticket was never opened (404)", async () => {
    // createSelfBookedReturn alerts and continues when the create fails, so
    // there is nothing on Amphora's side to cancel. Treating the 404 as fatal
    // would trap the customer in a return that exists only on our side.
    ORDER.returnMethod = "SELF";
    behaviour.amphoraFails = true;
    behaviour.amphoraFailureStatus = 404;

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.amphoraCancel).toHaveLength(0);
    expect(calls.refund).toEqual([ORDER.id]);
    expect(calls.reset).toEqual([ORDER.id]);
  });

  it("still aborts a self-booked return when Amphora fails for any other reason (500)", async () => {
    // A warehouse still expecting a parcel is exactly what step 1 guards —
    // the SELF exemption is narrow to the 404 case only.
    ORDER.returnMethod = "SELF";
    behaviour.amphoraFails = true;
    behaviour.amphoraFailureStatus = 500;

    expect(await cancel()).toEqual({ ok: false, reason: "carrier-cancel-failed" });
    expect(calls.refund).toHaveLength(0);
    expect(calls.reset).toHaveLength(0);
  });

  it("still aborts a non-self-booked return on a 404, even though the status matches", async () => {
    // The exemption is scoped to returnMethod === "SELF"; a 404 on a
    // Correos/Amphora-booked return is still a real, unexplained failure.
    behaviour.amphoraFails = true;
    behaviour.amphoraFailureStatus = 404;

    expect(await cancel()).toEqual({ ok: false, reason: "carrier-cancel-failed" });
    expect(calls.refund).toHaveLength(0);
  });

  it("still refunds when Shopify will not cancel, and alerts a human", async () => {
    // The return is already gone from Amphora. Stopping here would leave the
    // customer with no return and no money.
    behaviour.shopifyFails = true;

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.refund).toEqual([ORDER.id]);
    expect(calls.opsAlert.length).toBeGreaterThan(0);
  });

  it("alerts a human when the exchange stock hold cannot be released, and carries on", async () => {
    // The hold survives past `resetOrderReturn`, which drops the row from the
    // dashboard moments later — the alert is the only remaining record.
    behaviour.releaseFails = true;

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.opsAlert.some((entry) => entry.includes(ORDER.id))).toBe(true);
    expect(calls.refund).toEqual([ORDER.id]);
    expect(calls.reset).toEqual([ORDER.id]);
  });

  it("alerts a human when the refund cannot be issued", async () => {
    behaviour.refundOutcome = { refunded: false, reason: "error" };

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.opsAlert.length).toBeGreaterThan(0);
    expect(calls.reset).toEqual(["13217168851270"]);
  });

  it("names the payment intent in the refund-failure alert", async () => {
    // `resetOrderReturn` clears `stripe_payment_intent` moments later (it must:
    // a stale intent poisons the next return's refund). The alert is therefore
    // the ONLY surviving pointer to the charge ops has to reverse by hand —
    // without it they are left searching Stripe by email.
    behaviour.refundOutcome = { refunded: false, reason: "error" };

    await cancel();

    expect(calls.opsAlert.some((entry) => entry.includes("pi_stored"))).toBe(true);
  });

  it("alerts a human when a line carries no Shopify return id", async () => {
    // Skipping the cancel silently leaves an OPEN Shopify return behind after
    // the customer has already been refunded, and an admin validating it later
    // refunds the garment on top.
    ORDER.products = [{ confirmed: true, refunded: false, return_id: null }];

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.shopifyCancel).toHaveLength(0);
    expect(calls.opsAlert.some((entry) => entry.includes("13217168851270"))).toBe(true);
    expect(calls.refund).toEqual(["13217168851270"]);
  });

  it("still emails the customer, and alerts a human, when the reset throws", async () => {
    // The customer's money has already moved. An escaping throw here would
    // skip the email AND the alert, and leave the row `confirmed` with a
    // `return_id` for a Shopify return that no longer exists — so the
    // dashboard shows a phantom live return and an admin validating it refunds
    // the garment on top of the fee.
    behaviour.resetFails = true;

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.customerEmail).toHaveLength(1);
    expect(calls.opsAlert.some((entry) => entry.includes("13217168851270"))).toBe(true);
  });

  it("does not alert for a return that never owed anything", async () => {
    // A free return has nothing to refund; that is not a failure.
    behaviour.refundOutcome = { refunded: false, reason: "not-found" };

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.opsAlert).toHaveLength(0);
  });

  it("still reports success and resets the order when the confirmation email fails", async () => {
    // The cancellation is already done and correct by the time we try to
    // announce it; a dead Postmark call must not undo that or skip the reset.
    behaviour.emailFails = true;

    expect(await cancel()).toEqual({ ok: true });
    expect(calls.customerEmail).toHaveLength(0);
    expect(calls.reset).toEqual([ORDER.id]);
  });
});

describe("cancelling the same return twice", () => {
  // The realistic shape of this is not a hostile replay: it is a customer on a
  // slow connection clicking "Yes, cancel it" twice, or refreshing the page and
  // clicking again on a return that is already gone. The action is reachable
  // directly, so the guarantee has to live in the action, not the panel's
  // `isPending` flag.

  it("refunds exactly once and does not re-run the chain", async () => {
    const first = await cancel();
    const second = await cancel();

    expect(first).toEqual({ ok: true });
    // The second click reads the row the first one reset: no confirmed line,
    // so there is no return to cancel. It is refused at the gate, before
    // anything destructive or anything that moves money.
    expect(second).toEqual({ ok: false, reason: "no-return" });

    expect(calls.refund).toEqual(["13217168851270"]);
    expect(calls.amphoraCancel).toHaveLength(1);
    expect(calls.shopifyCancel).toHaveLength(1);
    expect(calls.releaseHold).toHaveLength(1);
    expect(calls.reset).toHaveLength(1);
    expect(calls.customerEmail).toHaveLength(1);
    expect(calls.opsAlert).toHaveLength(0);
  });

  it("runs the reversal chain exactly once across both calls", async () => {
    await cancel();
    await cancel();

    expect(calls.sequence).toEqual([
      "amphora",
      "shopify",
      "release",
      "refund",
      "reset",
      "email",
    ]);
  });

  it("does not hand the second call the first call's payment intent", async () => {
    // `resetOrderReturn` clears `stripe_payment_intent`. If it did not, a
    // second cancellation — of a return that may have cost nothing — would be
    // handed `pi_stored` and either replay the refund or fail into a
    // manual-refund alert for money that was never taken.
    await cancel();

    expect(ORDER.stripePaymentIntent).toBeNull();
  });

  it("leaves an already-settled return refused rather than refunded again", async () => {
    // Belt and braces on the same click: if an admin settles the return in the
    // window between the two calls, the second is refused as settled — never
    // walked into a second refund.
    await cancel();
    ORDER.products = [{ confirmed: true, refunded: true, return_id: "gid://shopify/Return/2" }];

    expect(await cancel()).toEqual({ ok: false, reason: "already-settled" });
    expect(calls.refund).toHaveLength(1);
  });
});

