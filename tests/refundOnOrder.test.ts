import { describe, expect, it } from "vitest";
import { judgeRootRefund, judgeRootRefundsOnOrder } from "@/lib/settlement/evidence";
import { planAdmission, type PayingOrder } from "@/lib/settlement/plan";
import { REFUND_CREATE } from "@/lib/settlement/effects";
import { line, planInput, TX } from "./support/planFixtures";

// `refundOnOrder` (refundCreate on the order holding the real payment, guarded
// by a note-marker replay check) is now the `root_refund` operation. Its
// variables are frozen at admission; refundCreate carries
// `@idempotent(key: "<op id>:<attempt>")`; and "did we already refund?" is the
// L5 evidence predicate over the root order's refunds. `getOrderRefundNotes`
// is gone: the evidence read returns whole refunds, not notes.

const ROOT = "gid://shopify/Order/1";

const paying = (over: Partial<PayingOrder> = {}): PayingOrder => ({
  orderGid: ROOT,
  presentment: null,
  gateways: new Map([[TX, "paypal"]]),
  transactionId: TX,
  ...over,
});

function rootRefund(over: Partial<PayingOrder> = {}) {
  const plan = planAdmission(planInput([line(1, { payCents: 4703 })], { isReplacement: true, paying: paying(over) }));
  if (!plan.ok) return plan;
  return plan.ops.find((o) => o.kind === "root_refund")!;
}

const refundFor = (op: any, over: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Refund/1",
  note: `${op.request.check.marker} Return on #311000`,
  transactions: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        kind: "REFUND",
        status: "SUCCESS",
        parentTransaction: { id: TX },
        amountSet: { presentmentMoney: op.request.check.money },
      },
    ],
  },
  ...over,
});

describe("root_refund — the request frozen at admission", () => {
  it("refunds the paying order once, carrying the marker in the note", () => {
    const op: any = rootRefund();
    const input = op.request.variables.input;
    expect(input.orderId).toBe(ROOT);
    expect(input.note.startsWith(`[${op.id}]`)).toBe(true);
    expect(input.transactions).toEqual([
      { orderId: ROOT, parentId: TX, amount: "47.03", gateway: "paypal", kind: "REFUND" },
    ]);
  });

  it("is sent with an idempotency key", () => {
    expect(REFUND_CREATE).toMatch(/refundCreate\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/);
  });

  it("converts to the paying order's presentment currency and declares it", () => {
    const op: any = rootRefund({
      presentment: {
        shop_money: { amount: "100.00", currency_code: "EUR" },
        presentment_money: { amount: "110.00", currency_code: "USD" },
      } as any,
    });
    expect(op.request.variables.input.currency).toBe("USD");
    expect(op.request.variables.input.transactions[0].amount).toBe("51.73");
  });

  it("uses the parent transaction's own gateway, not a hardcoded one", () => {
    expect((rootRefund() as any).request.variables.input.transactions[0].gateway).toBe("paypal");
  });

  it("holds, moving nothing, when the parent transaction is absent from the paying order", () => {
    expect(rootRefund({ gateways: new Map() })).toEqual({
      ok: false,
      held: "refund-transaction-not-on-paying-order",
    });
  });

  it("holds, moving nothing, when the paying order has no refundable transaction", () => {
    expect(rootRefund({ transactionId: null })).toEqual({ ok: false, held: "no-refund-transaction" });
  });
});

describe("root_refund — evidence on the paying order", () => {
  it("is done when exactly one refund carries the exact bracketed marker and matches", () => {
    const op: any = rootRefund();
    expect(judgeRootRefundsOnOrder(op.request, [refundFor(op)], 100)).toMatchObject({
      v: "done",
      effectRef: "gid://shopify/Refund/1",
    });
  });

  it("does not false-positive on a marker that is a prefix of another bracketed marker", () => {
    const op: any = rootRefund();
    const other = refundFor(op, { note: `${op.request.check.marker.replace("]", "0]")} other` });
    expect(judgeRootRefundsOnOrder(op.request, [other], 100).v).toBe("absent");
  });

  it("waits, deciding nothing, when the order cannot be read or its refunds are truncated", () => {
    const op: any = rootRefund();
    expect(judgeRootRefundsOnOrder(op.request, null, 100).v).toBe("wait");
    expect(judgeRootRefundsOnOrder(op.request, new Array(100).fill({ note: "" }), 100).v).toBe("wait");
  });

  it("is unresolved when two refunds carry the marker", () => {
    const op: any = rootRefund();
    expect(judgeRootRefundsOnOrder(op.request, [refundFor(op), refundFor(op)], 100).v).toBe("unresolved");
  });

  it("is unresolved when the marked refund moved a different amount", () => {
    const op: any = rootRefund();
    const wrong = refundFor(op);
    wrong.transactions.nodes[0].amountSet.presentmentMoney = { amount: "1.00", currencyCode: "EUR" };
    // Something carrying OUR marker moved money: never "absent", so never re-sent.
    expect(judgeRootRefund(op.request, wrong).v).toBe("unresolved");
    expect(judgeRootRefundsOnOrder(op.request, [wrong], 100).v).toBe("unresolved");
  });
});
