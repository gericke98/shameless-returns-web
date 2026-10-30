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

  it("scopes the gift card to this submission's line, by its own id", () => {
    const plan = credit([line(1, { payCents: 5175 }), line(2, { payCents: 1000 })]);
    if (!plan.ok) throw new Error(plan.held);
    const cards = plan.ops.filter((o) => o.kind === "gift_card");
    expect(cards.map((c) => c.members)).toEqual([[1], [2]]);
    expect(cards.map((c) => c.scope_key)).toEqual([
      `money:${submission().id}:1`,
      `money:${submission().id}:2`,
    ]);
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
