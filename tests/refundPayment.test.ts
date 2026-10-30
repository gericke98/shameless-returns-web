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
const SUB = "11111111-1111-4111-8111-111111111111";

describe("refundOrderPayment", () => {
  it("refunds the stored payment intent without touching the session list", async () => {
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" }, SUB);

    expect(result).toEqual({ refunded: true });
    expect(refunds[0].args.payment_intent).toBe("pi_stored");
    expect(listCalls).toHaveLength(0);
  });

  it("keys the refund on the cancelled submission, so a double submit cannot refund twice", async () => {
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" }, SUB);
    await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" }, SUB);

    expect(refunds[0].options.idempotencyKey).toBe(`cancel:${SUB}`);
    expect(refunds[1].options.idempotencyKey).toBe(`cancel:${SUB}`);
  });

  it("keys a later cancellation of a NEW submission on the same order separately", async () => {
    // A customer can cancel, start a fresh return, pay again, and cancel that
    // one too. That is a new submission (S2 plan L2), so a new key — reusing
    // the first key against a different payment_intent is what Stripe rejects.
    const { refundOrderPayment } = await import("@/actions/refundPayment");
    const NEXT = "22222222-2222-4222-8222-222222222222";

    await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_first" }, SUB);
    await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_second" }, NEXT);

    expect(refunds[0].options.idempotencyKey).toBe(`cancel:${SUB}`);
    expect(refunds[1].options.idempotencyKey).toBe(`cancel:${NEXT}`);
  });

  it("recovers the payment for a return booked before the column existed", async () => {
    sessions = [
      { metadata: { id: "someone-else" }, payment_intent: "pi_wrong" },
      { metadata: { id: ORDER.id }, payment_intent: "pi_found" },
    ];
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: null }, SUB);

    expect(result).toEqual({ refunded: true });
    expect(refunds[0].args.payment_intent).toBe("pi_found");
    expect(listCalls[0].customer_details).toEqual({ email: ORDER.email });
    expect(listCalls[0].status).toBe("complete");
  });

  it("reports no-payment for a return that never owed anything", async () => {
    // createStripeUrl returned { data: null }: nothing was ever charged.
    sessions = [];
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: null }, SUB);

    expect(result).toEqual({ refunded: false, reason: "not-found" });
    expect(refunds).toHaveLength(0);
  });

  it("reports an error rather than throwing when Stripe fails", async () => {
    // The label is already dead by the time this runs; the caller must be able
    // to finish the cancellation and alert a human.
    refundThrows = true;
    const { refundOrderPayment } = await import("@/actions/refundPayment");

    const result = await refundOrderPayment({ ...ORDER, stripePaymentIntent: "pi_stored" }, SUB);

    expect(result).toEqual({ refunded: false, reason: "error" });
  });
});
