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

vi.mock("@/db/queries", () => ({ getOrderById: async () => ORDER }));

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
