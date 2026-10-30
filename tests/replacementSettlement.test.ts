import { describe, expect, it } from "vitest";
import { planAdmission } from "@/lib/settlement/plan";
import { line, planInput, submission, TX } from "./support/planFixtures";

// A return of one of OUR replacement orders: the replacement's own payment is
// the €0.01 placeholder, so the money goes to the ROOT order that holds the
// real payment (admission resolves it with `rootOrderIdOf`), as a
// `root_refund`, and the goods are booked on the replacement's own return.
//
// Removed behaviour, replaced by the ledger (S2 plan L4/L5):
//  - "claims the row BEFORE the money" / "claim-stuck" — the claim is now the
//    operation row itself (claim → dispatch → record, fenced on owner+attempt),
//    pinned in tests/settlementLedgerDb.test.ts;
//  - the hand-refund regex check (`hasUnmarkedRefundFor`) — evidence is the
//    op's own explicit `[<op id>]` marker, never a regex over other notes;
//  - the possible-top-up alert (`alertPossibleTopUp`/`wasProductSwap`) — a
//    replacement's funding is explicit data in `replacement_lines`
//    (tests/replacementOrderLookup.test.ts).

const ROOT = "gid://shopify/Order/1";
const replacement = (tender: "refund" | "credit" = "refund", payCents = 4703) =>
  planAdmission(
    planInput([line(1, { payCents })], {
      submission: submission({ tender }),
      isReplacement: true,
      paying: {
        orderGid: ROOT,
        presentment: null,
        gateways: new Map([[TX, "shopify_payments"]]),
        transactionId: TX,
      },
    })
  );

describe("refund lane on a replacement order", () => {
  it("moves the money on the ROOT order, for exactly the agreed pay_cents", () => {
    const plan = replacement();
    if (!plan.ok) throw new Error(plan.held);
    const money = plan.ops.find((o) => o.kind === "root_refund") as any;
    expect(money.request.variables.input.orderId).toBe(ROOT);
    expect(money.amount_cents).toBe(4703);
  });

  it("books the goods on the replacement's own return, with no money in it", () => {
    const plan = replacement();
    if (!plan.ok) throw new Error(plan.held);
    const goods = plan.ops.find((o) => o.kind === "process_goods") as any;
    expect(goods.request.variables.input.returnId).toBe("gid://shopify/Return/1");
    expect(goods.request.variables.input.financialTransfer).toBeUndefined();
  });

  it("never refunds through the replacement's own placeholder transaction", () => {
    const plan = replacement();
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.some((o) => o.kind === "process_refund")).toBe(false);
  });

  it("books the goods and moves no money for a line that owes nothing", () => {
    const plan = replacement("refund", 0);
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.map((o) => o.kind)).toEqual(["process_goods"]);
  });

  it("holds, moving nothing, when the root has no refundable transaction", () => {
    const plan = planAdmission(
      planInput([line(1)], {
        isReplacement: true,
        paying: { orderGid: ROOT, presentment: null, gateways: new Map(), transactionId: null },
      })
    );
    expect(plan).toEqual({ ok: false, held: "no-refund-transaction" });
  });

  it("holds when the row has no return line item to settle", () => {
    const plan = planAdmission(planInput([line(1, { returnLineItemId: null })], { isReplacement: true }));
    expect(plan).toEqual({ ok: false, held: "no-return-line:1" });
  });
});

describe("credit lane on a replacement order", () => {
  it("mints the gift card for the agreed pay_cents and refunds nothing", () => {
    const plan = replacement("credit", 5408);
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.map((o) => [o.kind, o.amount_cents]).sort()).toEqual([
      ["gift_card", 5408],
      ["process_goods", 0],
    ]);
  });
});
