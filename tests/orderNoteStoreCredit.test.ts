import { describe, expect, it } from "vitest";
import { judgeGiftCard } from "@/lib/settlement/evidence";
import { planAdmission } from "@/lib/settlement/plan";
import { line, ORDER, planInput, submission } from "./support/planFixtures";

// Pre-S2, `noteStoreCreditOnOrder` appended a sentence to `order.note` with
// `orderUpdate` (which REPLACES the note, so it had to read-modify-write and
// dedupe on re-runs). That is removed behaviour: the gift card is the record.
// Its own note names the order and carries the operation's marker, and the
// marker is part of what makes the card count as ours.

const card = () => {
  const p = planAdmission(planInput([line(1)], { submission: submission({ tender: "credit" }) }));
  if (!p.ok) throw new Error(p.held);
  return p.ops.find((o) => o.kind === "gift_card")!;
};

describe("store credit explains itself on the gift card", () => {
  it("names the order the credit is for", () => {
    expect((card().request.variables as any).input.note).toContain(ORDER.orderNumber);
  });

  it("carries the operation marker, so a re-run is recognised rather than re-minted", () => {
    const op = card();
    expect((op.request.variables as any).input.note).toContain(`[${op.id}]`);
  });

  it("does not count a card without the marker as ours", () => {
    const req = card().request as any;
    const verdict = judgeGiftCard(req, {
      id: "gid://shopify/GiftCard/1",
      customer: { id: req.check.customerGid },
      initialValue: req.check.money,
      lastCharacters: req.check.code.slice(-4),
      note: "a card someone made by hand",
    });
    expect(verdict.v).toBe("unresolved");
  });

  it("writes nothing to the order itself — no orderUpdate anywhere in settlement", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const f of readdirSync("lib/settlement")) {
      expect(readFileSync(`lib/settlement/${f}`, "utf8")).not.toContain("orderUpdate");
    }
  });
});
