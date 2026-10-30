import { describe, expect, it } from "vitest";
import { planAdmission } from "@/lib/settlement/plan";
import { line, planInput, TX } from "./support/planFixtures";

// A refund-lane line with no refundable transaction is HELD at admission
// (S2): no operation is written, so nothing can reach Shopify, mark the line,
// or close anything. Pre-S2 this guard lived inside `settleReturnLine`.

const withTx = (transactionId: string | null) =>
  planAdmission(
    planInput([line(1)], {
      rows: new Map([[1, { returnId: "gid://shopify/Return/1", transactionId }]]),
    })
  );

describe("admission holds a refund line with no refundable transaction", () => {
  it("writes no operation at all", () => {
    expect(withTx(null).ok).toBe(false);
  });

  it("names the missing transaction and the line", () => {
    expect(withTx(null)).toEqual({ ok: false, held: "no-refund-transaction:1" });
  });

  it("treats an empty-string transaction id the same as a missing one", () => {
    expect(withTx("")).toEqual({ ok: false, held: "no-refund-transaction:1" });
  });

  it("still admits normally when a real transaction is stored", () => {
    const plan = withTx(TX);
    if (!plan.ok) throw new Error(plan.held);
    const op = plan.ops[0] as any;
    expect(op.kind).toBe("process_refund");
    expect(op.request.variables.input.financialTransfer.issueRefund.orderTransactions[0].parentId).toBe(TX);
  });

  it("holds the WHOLE admission, not just the bad line", () => {
    const plan = planAdmission(
      planInput([line(1), line(2)], {
        rows: new Map([
          [1, { returnId: "gid://shopify/Return/1", transactionId: TX }],
          [2, { returnId: "gid://shopify/Return/1", transactionId: null }],
        ]),
      })
    );
    expect(plan).toEqual({ ok: false, held: "no-refund-transaction:2" });
  });
});
