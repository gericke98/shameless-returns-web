import { describe, expect, it } from "vitest";
import { planAdmission } from "@/lib/settlement/plan";
import { line, planInput, submission, RETURN } from "./support/planFixtures";

// The store-credit lane under S2: settlement EXECUTES the agreement. The
// gift card's value is the line's agreed `pay_cents` — already the credit
// amount (×1.15, leg once per basket) when the customer accepted it — and the
// goods are booked by their own returnProcess.
//
// Replaces the pre-S2 tests of `processGiftCardReturn`: the zero-transaction
// `returnRefund` record and the `orderUpdate` note it wrote are removed
// behaviour (the plan's `returnProcess` books the goods, and the gift card's
// own note carries the operation marker).

const credit = (lines = [line(1, { payCents: 5175 })]) =>
  planAdmission(planInput(lines, { submission: submission({ tender: "credit" }) }));

describe("settling a store-credit return", () => {
  it("books the goods with a returnProcess that moves no money", () => {
    const plan = credit();
    if (!plan.ok) throw new Error(plan.held);
    const goods = plan.ops.find((o) => o.kind === "process_goods")! as any;
    expect(goods.request.variables.input.returnId).toBe(RETURN);
    expect(goods.request.variables.input).not.toHaveProperty("financialTransfer");
    expect(goods.amount_cents).toBe(0);
  });

  it("mints the gift card at exactly the agreed pay_cents — nothing recomputed", () => {
    const plan = credit();
    if (!plan.ok) throw new Error(plan.held);
    const card = plan.ops.find((o) => o.kind === "gift_card")! as any;
    expect(card.amount_cents).toBe(5175);
    expect(card.request.variables.input.initialValue).toBe("51.75");
  });

  it("never refunds a card as well — store credit moves no card money", () => {
    const plan = credit();
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.map((o) => o.kind).sort()).toEqual(["gift_card", "process_goods"]);
  });

  it("pays every credit line of one admission with ONE card, members naming each line", () => {
    const plan = credit([line(1, { payCents: 5175 }), line(2, { payCents: 1000 })]);
    if (!plan.ok) throw new Error(plan.held);
    const cards = plan.ops.filter((o) => o.kind === "gift_card");
    expect(cards.map((c) => c.members)).toEqual([[1, 2]]);
    expect(cards.map((c) => c.amount_cents)).toEqual([6175]);
    expect(cards.map((c) => c.scope_key)).toEqual([`credit:${submission().id}:1,2`]);
  });

  // #312385: two lines of 86,82 and a 1-cent residual became three cards.
  it("folds the residual into the same card when the admission covers every paying line", () => {
    const s = submission({ tender: "credit", residualCents: 1 });
    const plan = planAdmission(
      planInput([line(1, { payCents: 8682 }), line(2, { payCents: 8682 })], { submission: s })
    );
    if (!plan.ok) throw new Error(plan.held);
    const cards = plan.ops.filter((o) => o.kind === "gift_card") as any[];
    expect(cards).toHaveLength(1);
    expect(cards[0].amount_cents).toBe(17365);
    expect(cards[0].request.variables.input.initialValue).toBe("173.65");
    expect(cards[0].members).toEqual([1, 2]);
    expect(cards[0].scope_key).toBe(`residual:${s.id}`);
  });

  it("pays a later admission with its own card and the residual only then", () => {
    const s = submission({ tender: "credit", residualCents: 1 });
    const lines = [line(1, { payCents: 8682 }), line(2, { payCents: 8682 })];
    const first = planAdmission(planInput(lines, { submission: s, admit: [1] }));
    if (!first.ok) throw new Error(first.held);
    expect(
      first.ops.filter((o) => o.kind === "gift_card").map((c) => [c.amount_cents, c.members, c.scope_key])
    ).toEqual([[8682, [1], `credit:${s.id}:1`]]);

    const second = planAdmission(
      planInput(lines, {
        submission: s,
        admit: [2],
        existing: first.ops.map((o) => ({ id: o.id, kind: o.kind, scopeKey: o.scope_key, members: o.members })),
      })
    );
    if (!second.ok) throw new Error(second.held);
    expect(
      second.ops.filter((o) => o.kind === "gift_card").map((c) => [c.amount_cents, c.members, c.scope_key])
    ).toEqual([[8683, [1, 2], `residual:${s.id}`]]);
  });

  it("never pays a line again whose money an earlier card already owns", () => {
    const s = submission({ tender: "credit" });
    const plan = planAdmission(
      planInput([line(1, { payCents: 8682 }), line(2, { payCents: 8682 })], {
        submission: s,
        existing: [{ id: "op-old", kind: "gift_card", scopeKey: `credit:${s.id}:1,2`, members: [1, 2] }],
      })
    );
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.filter((o) => o.kind === "gift_card")).toEqual([]);
  });

  it("respects per-line cards admitted before one-card-per-admission", () => {
    const s = submission({ tender: "credit", residualCents: 1 });
    const plan = planAdmission(
      planInput([line(1, { payCents: 8682 }), line(2, { payCents: 8682 })], {
        submission: s,
        admit: [2],
        existing: [{ id: "op-legacy", kind: "gift_card", scopeKey: `money:${s.id}:1`, members: [1] }],
      })
    );
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.filter((o) => o.kind === "gift_card").map((c) => [c.amount_cents, c.members])).toEqual([
      [8683, [1, 2]],
    ]);
  });

  it("does not mint a card for a credit line whose return is no longer open", () => {
    const input = planInput([line(1, { payCents: 5175 })], { submission: submission({ tender: "credit" }) });
    input.returns.get(RETURN)!.status = "CLOSED";
    expect(planAdmission(input)).toEqual({ ok: false, held: "return-not-open:CLOSED" });
  });

  it("freezes a code we generated, and names the card's customer and marker", () => {
    const plan = credit();
    if (!plan.ok) throw new Error(plan.held);
    const card = plan.ops.find((o) => o.kind === "gift_card")!;
    const req = card.request as any;
    expect(req.variables.input.code).toBe(req.check.code);
    expect(req.variables.input.customerId).toBe("gid://shopify/Customer/9");
    expect(req.variables.input.note).toContain(`[${card.id}]`);
  });

  it("mints nothing for a line that owes nothing", () => {
    const plan = credit([line(1, { payCents: 0 })]);
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.map((o) => o.kind)).toEqual(["process_goods"]);
  });

  it("holds, moving nothing, when the return has no customer to give a card to", () => {
    const input = planInput([line(1)], { submission: submission({ tender: "credit" }) });
    input.returns.get(RETURN)!.customerGid = null;
    expect(planAdmission(input)).toEqual({ ok: false, held: "no-customer-for-gift-card" });
  });
});
