import { describe, expect, it } from "vitest";
import { judgeGiftCard } from "@/lib/settlement/evidence";
import { planAdmission } from "@/lib/settlement/plan";
import { line, planInput, submission } from "./support/planFixtures";

// Pre-S2, `processGiftCardReturn` stamped `productsorder.gift_card_id` scoped
// by variant alone and wrote one customer's card onto every order sharing the
// garment. Under S2 the card belongs to its OPERATION: its members are explicit
// productsorder ids, and the card's gid is that operation's `effect_ref`,
// recorded only after the card is proven to be the one we froze. Nothing is
// keyed by variant, and `gift_card_id` is no longer written (removed
// behaviour; nothing reads it).

const plan = () => {
  const p = planAdmission(
    planInput([line(1), line(2)], { submission: submission({ tender: "credit" }) })
  );
  if (!p.ok) throw new Error(p.held);
  return p;
};

describe("a gift card belongs to its operation", () => {
  it("is scoped to one line of one submission by id, not by variant", () => {
    const cards = plan().ops.filter((o) => o.kind === "gift_card");
    expect(cards.map((c) => c.members)).toEqual([[1], [2]]);
    expect(JSON.stringify(cards.map((c) => c.request))).not.toContain("variant");
  });

  it("records the card as done only when it is provably the frozen one", () => {
    const op = plan().ops.find((o) => o.kind === "gift_card")!;
    const req = op.request as any;
    const card = {
      id: "gid://shopify/GiftCard/1",
      customer: { id: req.check.customerGid },
      initialValue: req.check.money,
      lastCharacters: req.check.code.slice(-4),
      note: `x ${req.check.noteMarker}`,
    };
    expect(judgeGiftCard(req, card)).toMatchObject({ v: "done", effectRef: "gid://shopify/GiftCard/1" });
    expect(judgeGiftCard(req, { ...card, customer: { id: "gid://shopify/Customer/OTHER" } }).v).toBe("unresolved");
  });
});
