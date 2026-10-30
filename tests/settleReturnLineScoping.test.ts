import { describe, expect, it } from "vitest";
import { planAdmission } from "@/lib/settlement/plan";
import { line, planInput, RETURN, submission, TX } from "./support/planFixtures";

// Every operation names exactly the line it settles, by explicit id: its
// `members` are productsorder ids, and its request names THIS line's return,
// return line item, reverse-fulfillment line and transaction, read from the
// row and the return — never from the caller, never by variant. Money is the
// line's agreed `pay_cents`, never `price - leg` recomputed.
//
// "closes the return it actually settled" is removed behaviour: returnClose
// is gone; `returnProcess` of the frozen line is the goods effect.

const OTHER_RETURN = "gid://shopify/Return/2";

function twoReturns() {
  const l1 = line(1, { payCents: 4350 });
  const l2 = line(2, { payCents: 1234 });
  const input = planInput([l1, l2], {
    rows: new Map([
      [1, { returnId: RETURN, transactionId: TX }],
      [2, { returnId: OTHER_RETURN, transactionId: "gid://shopify/OrderTransaction/8" }],
    ]),
  });
  const facts = input.returns.get(RETURN)!;
  input.returns.set(OTHER_RETURN, { ...facts, returnGid: OTHER_RETURN });
  const plan = planAdmission(input);
  if (!plan.ok) throw new Error(plan.held);
  return plan.ops as any[];
}

describe("each operation names exactly the row it pays for", () => {
  it("has the row's own id as its only member", () => {
    expect(twoReturns().map((o) => o.members)).toEqual([[1], [2]]);
  });

  it("names the row's return, return line item and transaction", () => {
    const [a, b] = twoReturns();
    expect(a.request.variables.input.returnId).toBe(RETURN);
    expect(b.request.variables.input.returnId).toBe(OTHER_RETURN);
    expect(a.request.variables.input.returnLineItems[0].id).toBe("gid://shopify/ReturnLineItem/1");
    expect(b.request.variables.input.financialTransfer.issueRefund.orderTransactions[0].parentId).toBe(
      "gid://shopify/OrderTransaction/8"
    );
  });

  it("refunds the line's agreed pay_cents, not a price recomputed at settlement", () => {
    const [a, b] = twoReturns();
    expect([a.amount_cents, b.amount_cents]).toEqual([4350, 1234]);
    expect(a.request.variables.input.financialTransfer.issueRefund.orderTransactions[0].transactionAmount.amount).toBe(
      "43.50"
    );
  });

  it("books the goods NOT_RESTOCKED against the frozen reverse-fulfillment line", () => {
    const [a] = twoReturns();
    expect(a.request.variables.input.returnLineItems[0].dispositions).toEqual([
      {
        reverseFulfillmentOrderLineItemId: "gid://shopify/ReverseFulfillmentOrderLineItem/1",
        quantity: 1,
        dispositionType: "NOT_RESTOCKED",
      },
    ]);
  });

  it("admits only the lines asked for", () => {
    const plan = planAdmission(planInput([line(1), line(2)], { admit: [2] }));
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.map((o) => o.members)).toEqual([[2]]);
  });

  it("holds a line asked for that is not in the submission", () => {
    expect(planAdmission(planInput([line(1)], { admit: [9] }))).toEqual({
      ok: false,
      held: "not-in-submission:9",
    });
  });

  it("pays the submission's residual cents once, only when every paying line is admitted", () => {
    const s = submission({ residualCents: 1 });
    const partial = planAdmission(planInput([line(1), line(2)], { submission: s, admit: [1] }));
    if (!partial.ok) throw new Error(partial.held);
    expect(partial.ops.some((o) => o.scope_key === `residual:${s.id}`)).toBe(false);

    const whole = planAdmission(planInput([line(1), line(2)], { submission: s }));
    if (!whole.ok) throw new Error(whole.held);
    expect(whole.ops.filter((o) => o.scope_key === `residual:${s.id}`).map((o) => o.amount_cents)).toEqual([1]);
  });

  it("never plans the residual again once it exists", () => {
    const s = submission({ residualCents: 1 });
    const plan = planAdmission(
      planInput([line(1)], {
        submission: s,
        existing: [
          { id: "op-m", kind: "process_refund", scopeKey: `money:${s.id}:1` },
          { id: "op-r", kind: "root_refund", scopeKey: `residual:${s.id}` },
        ],
      })
    );
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops).toEqual([]);
  });
});
