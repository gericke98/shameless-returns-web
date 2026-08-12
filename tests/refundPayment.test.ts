import { beforeEach, describe, expect, it, vi } from "vitest";

// Giving the customer their money back.
//
// Stored intent first; a session lookup for anything booked before the column
// existed. Idempotent, because a double click must not refund twice.

const refunds: Array<{ args: any; options: any }> = [];
const listCalls: any[] = [];
let sessions: any[] = [];
let refundThrows = false;

vi.mock("@/lib/stripe", () => ({
  stripe: {
    refunds: {
      create: async (args: any, options: any) => {
        if (refundThrows) throw new Error("stripe down");
        refunds.push({ args, options });
        return { id: "re_1" };
      },
    },
    checkout: {
      sessions: {
        list: (params: any) => {
          listCalls.push(params);
          return {
            autoPagingEach: async (fn: (s: any) => any) => {
              for (const s of sessions) if ((await fn(s)) === false) return;
            },
          };
        },
      },
    },
  },
}));

beforeEach(() => {
  refunds.length = 0;
  listCalls.length = 0;
  sessions = [];
  refundThrows = false;
});

const ORDER = { id: "13217168851270", email: "customer@example.com" };

describe("refundOrderPayment", () => {
  it("refunds the stored payment intent without touching the session list", async () => {
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" });

    expect(result).toEqual({ refunded: true });
    expect(refunds[0].args.payment_intent).toBe("pi_stored");
    expect(listCalls).toHaveLength(0);
  });

  it("keys the refund so a double submit cannot refund twice", async () => {
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" });

    expect(refunds[0].options.idempotencyKey).toBe(`cancel:${ORDER.id}`);
  });

  it("recovers the payment for a return booked before the column existed", async () => {
    sessions = [
      { metadata: { id: "someone-else" }, payment_intent: "pi_wrong" },
      { metadata: { id: ORDER.id }, payment_intent: "pi_found" },
    ];
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: null });

    expect(result).toEqual({ refunded: true });
    expect(refunds[0].args.payment_intent).toBe("pi_found");
    expect(listCalls[0].customer_details).toEqual({ email: ORDER.email });
    expect(listCalls[0].status).toBe("complete");
  });

  it("reports no-payment for a return that never owed anything", async () => {
    // createStripeUrl returned { data: null }: nothing was ever charged.
    sessions = [];
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: null });

    expect(result).toEqual({ refunded: false, reason: "not-found" });
    expect(refunds).toHaveLength(0);
  });

  it("reports an error rather than throwing when Stripe fails", async () => {
    // The label is already dead by the time this runs; the caller must be able
    // to finish the cancellation and alert a human.
    refundThrows = true;
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" });

    expect(result).toEqual({ refunded: false, reason: "error" });
  });
});
