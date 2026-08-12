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
  shopifyFails: false,
  releaseFails: false,
  refundOutcome: { refunded: true } as any,
  emailFails: false,
};

const ORDER: Record<string, any> = {
  id: "13217168851270",
  orderNumber: "#311148",
  email: "customer@example.com",
  locale: "es",
  locator: "PQ1ES",
  returnStatus: "APROVED",
  stripePaymentIntent: "pi_stored",
  products: [{ confirmed: true, refunded: false, return_id: "gid://shopify/Return/1" }],
};

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
  resetOrderReturn: async (id: string) => {
    calls.reset.push(id);
    calls.sequence.push("reset");
  },
}));
vi.mock("@/actions/shipping", () => ({
  readCarrierMovement: async (locator: string | null | undefined) => {
    calls.carrierRead.push(String(locator));
    return behaviour.movement;
  },
}));
vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  cancelAmphoraReturn: async (id: string) => {
    if (behaviour.amphoraFails) throw new Error("amphora 500");
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
  behaviour.shopifyFails = false;
  behaviour.releaseFails = false;
  behaviour.refundOutcome = { refunded: true };
  behaviour.emailFails = false;
  ORDER.products = [{ confirmed: true, refunded: false, return_id: "gid://shopify/Return/1" }];
  ORDER.returnStatus = "APROVED";
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
    expect(calls.reset).toEqual([ORDER.id]);
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
