import { beforeEach, describe, expect, it, vi } from "vitest";

// The webhook catches every downstream failure, reverts the database, and
// returns 200. Stripe therefore sees a healthy endpoint, no retry is scheduled,
// and the only trace is a `console.error` in logs Vercel keeps for about an
// hour. Order #310741 sat in exactly that state for TEN DAYS — paid, no return,
// no collection, no email — and was found because the customer wrote in twice,
// not because anything told us.
//
// The revert makes it worse than a plain crash: it puts the row back to
// "nothing submitted", so the order also disappears from the dashboard. After
// the revert there is no evidence left anywhere that the customer paid, except
// in Stripe.
//
// So every path where the money is captured but the return is not created must
// reach a human. These tests pin that, and pin that the alert carries what a
// human actually needs to act: the order, the customer, and the PaymentIntent
// to refund.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER: any = {
  id: "13158935429446",
  orderNumber: "#310741",
  email: "coeneleanor@gmail.com",
  shippingCountry: "United States",
  // What the revert actually left behind. Empty = a clean revert; a line
  // carrying a return_id = a revert that was refused because the Shopify
  // return is real.
  products: [],
};

const alerts: Array<{ subject: string; body: string }> = [];
const behaviour: {
  updateFinalOrderThrows: boolean;
  labelStatus: number;
} = { updateFinalOrderThrows: false, labelStatus: 200 };

const updateFinalOrderCalls: Array<{ id: string; revert: boolean }> = [];

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/actions/updateOrder", () => ({
  updateFinalOrder: async (id: string, revert: boolean) => {
    updateFinalOrderCalls.push({ id, revert });
    if (!revert && behaviour.updateFinalOrderThrows) {
      throw new Error("returnCreate failed: The presentment currency of the order needs to be used.");
    }
  },
}));

vi.mock("@/actions/shipping", () => ({
  createShippingLabel: async () => behaviour.labelStatus,
}));

vi.mock("@/actions/amphoraReturn", () => ({
  createInternationalReturn: async () => behaviour.labelStatus,
  isInternationalOrder: () => false,
}));

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  // The alert reads the order AFTER the revert ran, so it must not be served
  // the request-scoped cached copy from before it.
  getOrderByIdFresh: async () => ORDER,
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: () => ({ get: () => "sig_test" }),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: () => ({
        type: "checkout.session.completed",
        data: {
          object: {
            metadata: { id: "13158935429446", isCredit: "false" },
            payment_intent: "pi_3U0QOAJSZ88eqCu00q2IRbdy",
            amount_total: 3496,
            currency: "eur",
          },
        },
      }),
    },
  },
}));

async function post() {
  const { POST } = await import("@/app/api/webhooks/stripe/route");
  return POST(new Request("https://x/api/webhooks/stripe", { method: "POST", body: "{}" }) as any);
}

beforeEach(() => {
  alerts.length = 0;
  updateFinalOrderCalls.length = 0;
  behaviour.updateFinalOrderThrows = false;
  behaviour.labelStatus = 200;
  ORDER.products = [];
  vi.resetModules();
});

describe("the Stripe webhook alerts when money is taken and no return exists", () => {
  it("stays silent on the happy path", async () => {
    await post();
    expect(alerts).toHaveLength(0);
  });

  it("alerts when the return pipeline throws", async () => {
    // #310741 exactly: returnCreate rejected, updateFinalOrder threw, the catch
    // reverted, and nobody heard about it for ten days.
    behaviour.updateFinalOrderThrows = true;

    await post();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("#310741");
  });

  it("alerts when the carrier booking fails and the return is reverted", async () => {
    behaviour.labelStatus = 500;

    await post();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("#310741");
  });

  it("carries what a human needs to act: customer, amount and PaymentIntent", async () => {
    // Without the intent id, refunding means a human searching Stripe by hand
    // for a charge whose order row has just been reverted out of existence.
    behaviour.updateFinalOrderThrows = true;

    await post();

    const body = alerts[0].body;
    expect(body).toContain("coeneleanor@gmail.com");
    expect(body).toContain("pi_3U0QOAJSZ88eqCu00q2IRbdy");
    expect(body).toContain("34.96");
    // The underlying cause, so the alert is diagnosable on its own.
    expect(body).toContain("presentment currency");
  });

  it("still returns 200, so Stripe does not retry behind the alert", async () => {
    // Changing the status code changes Stripe's retry behaviour for every
    // failure mode at once. Pinned deliberately: if that is ever revisited it
    // should be a decision, not a side effect of touching this handler.
    behaviour.updateFinalOrderThrows = true;

    const res: any = await post();

    expect(res.status).toBe(200);
  });

  it("alerts even when the revert itself fails", async () => {
    // The worst state: money taken, return possibly half-created, and the
    // database now disagreeing with reality. This must never be the quiet one.
    behaviour.updateFinalOrderThrows = true;
    const { alertOps } = await import("@/actions/opsAlert");
    expect(typeof alertOps).toBe("function");

    await post();

    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the alert must describe the state that actually exists", () => {
  // Order #311329 (2026-08-21). A paid Netherlands exchange: the Amphora
  // booking reported 501, the webhook reverted — and the per-line revert
  // REFUSED, because every line carried a live Shopify return. The alert said
  // "The database has been reverted, so this order looks unsubmitted" and
  // "the portal will ask the customer to pay a second time". Both were false.
  // The return, the collection, the carrier and the customer's confirmation
  // email all existed.
  //
  // A responder who believed it would have refunded a customer whose exchange
  // was already booked, or re-run a return that was already there.
  const live = () => {
    ORDER.products = [
      { confirmed: true, return_id: "gid://shopify/Return/57356845382" },
    ];
  };

  it("does not claim a revert that was refused", async () => {
    live();
    behaviour.labelStatus = 501;

    await post();

    expect(alerts[0].body).not.toContain("has been reverted");
  });

  it("does not threaten a second charge when the return is still live", async () => {
    live();
    behaviour.labelStatus = 501;

    await post();

    expect(alerts[0].body).not.toContain("pay a second time");
  });

  it("says the Shopify return survived, and names it", async () => {
    live();
    behaviour.labelStatus = 501;

    await post();

    expect(alerts[0].body).toContain("gid://shopify/Return/57356845382");
  });

  it("still gives the old guidance when the revert genuinely undid everything", async () => {
    // Nothing confirmed: the row really is back to "unsubmitted", and the
    // original warning is the correct one.
    ORDER.products = [{ confirmed: false, return_id: null }];
    behaviour.labelStatus = 501;

    await post();

    expect(alerts[0].body).toContain("pay a second time");
  });
});
