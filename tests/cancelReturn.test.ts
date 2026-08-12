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
  amphoraCancel: [] as string[],
  shopifyCancel: [] as string[],
  releaseHold: [] as string[],
  refund: [] as string[],
  reset: [] as string[],
  customerEmail: [] as string[],
  opsAlert: [] as string[],
};

const behaviour = {
  access: true,
  movement: "not-moved" as "moved" | "not-moved" | "unreadable",
  amphoraFails: false,
  shopifyFails: false,
  refundOutcome: { refunded: true } as any,
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
  getOrderById: async () => ORDER,
  cancelShopifyReturn: async (id: string) => {
    calls.shopifyCancel.push(id);
    return behaviour.shopifyFails ? { success: false, errors: "nope" } : { success: true };
  },
  resetOrderReturn: async (id: string) => {
    calls.reset.push(id);
  },
}));
vi.mock("@/actions/shipping", () => ({
  readCarrierMovement: async () => behaviour.movement,
}));
vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  cancelAmphoraReturn: async (id: string) => {
    if (behaviour.amphoraFails) throw new Error("amphora 500");
    calls.amphoraCancel.push(id);
    return { id };
  },
}));
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async (id: string) => {
    calls.releaseHold.push(id);
    return true;
  },
}));
vi.mock("@/actions/refundPayment", () => ({
  refundOrderPayment: async (order: any) => {
    calls.refund.push(order.id);
    return behaviour.refundOutcome;
  },
}));
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => {
    calls.opsAlert.push(subject);
  },
}));
vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) calls.customerEmail.push(url);
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
  behaviour.refundOutcome = { refunded: true };
  ORDER.products = [{ confirmed: true, refunded: false, return_id: "gid://shopify/Return/1" }];
  ORDER.returnStatus = "APROVED";
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("cancelling an eligible return", () => {
  it("reports success", async () => {
    expect(await cancel()).toEqual({ ok: true });
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
});

describe("when the return may not be cancelled", () => {
  it("refuses a caller with no session, and touches nothing", async () => {
    behaviour.access = false;
    expect(await cancel()).toEqual({ ok: false, reason: "forbidden" });
    expect(calls.amphoraCancel).toHaveLength(0);
    expect(calls.refund).toHaveLength(0);
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
});
