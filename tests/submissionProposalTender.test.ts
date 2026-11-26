// The payout tender is the customer's explicit choice, never a default
// (#312385: a pre-selected "store credit" paid a customer in gift cards).
import { beforeEach, describe, expect, it, vi } from "vitest";

const basketLines = vi.hoisted(() => ({ value: [] as any[] }));
const proposeSubmission = vi.hoisted(() => vi.fn());

// FX §#1: Amphora covers every replacement here; refusals are tested in tests/submissionStockRefusal.test.ts.
vi.mock("@/lib/settlement/stockGate", () => ({ acceptCoverage: async () => ({ kind: "covered" }) }));
vi.mock("@/db/fees", () => ({ getFeeTable: vi.fn(async () => ({})) }));
vi.mock("@/db/queries", () => ({ getOrderTotal: vi.fn(async () => ({})) }));
vi.mock("@/lib/server/submissionScope", () => ({ proposeSubmission }));
vi.mock("@/lib/feeLegs", () => ({ feeLegsForOrder: vi.fn(() => ({})) }));
vi.mock("@/lib/fees", () => ({
  resolveFee: vi.fn(() => ({ feeCents: 500, returnLegCents: 500, outboundLegCents: 0 })),
}));
vi.mock("@/lib/fulfillmentLines", () => ({
  resolveFulfillmentLineItems: vi.fn(
    async (sel: Array<{ productsorderId: number }>) =>
      new Map(sel.map((s) => [s.productsorderId, `gid://shopify/FulfillmentLineItem/${s.productsorderId}`]))
  ),
}));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: vi.fn(async () => ({
    order: { products: basketLines.value.map((l) => ({ id: l.id, lineItemId: `li${l.id}` })) },
    basket: { hasItems: basketLines.value.length > 0, lines: basketLines.value },
  })),
}));

import { proposeCurrentSelection as propose } from "@/lib/submissionProposal";
import { vid, vsub } from "./support/verified";

/** The proposal, or null for a refusal (F1: refusals are values, not throws). */
const proposeCurrentSelection = async (...args: [string, boolean | null, "CORREOS"]) => {
  const result = await propose(vid(args[0]), args[1], args[2]);
  return result.ok ? result.proposal : null;
};

const line = (id: number, returnedCents: number, replacementCents = 0) => ({
  id,
  action: replacementCents ? "CAMBIO" : "DEVOLUCION",
  quantity: 1,
  returnedCents,
  replacementCents,
  degraded: false,
});

describe("proposeCurrentSelection tender", () => {
  beforeEach(() => {
    proposeSubmission.mockReset();
    proposeSubmission.mockResolvedValue({ ok: true, submission: vsub("o1", "sub-1") });
  });

  it("refuses to save terms when money comes back and no payout was chosen", async () => {
    basketLines.value = [line(1, 7800), line(2, 7800)];
    expect(await propose(vid("o1"), null, "CORREOS")).toEqual({ ok: false, reason: "payout-required" });
    expect(proposeSubmission).not.toHaveBeenCalled();
  });

  it("saves credit only when credit was chosen", async () => {
    basketLines.value = [line(1, 7800), line(2, 7800)];
    const p = await proposeCurrentSelection("o1", true, "CORREOS");
    expect(p?.agreement.tender).toBe("credit");
    expect(p?.agreement.owedCents).toBe(17365); // (15600 − 500) × 1.15
  });

  it("saves a card refund when the card was chosen", async () => {
    basketLines.value = [line(1, 7800), line(2, 7800)];
    const p = await proposeCurrentSelection("o1", false, "CORREOS");
    expect(p?.agreement.tender).toBe("refund");
    expect(p?.agreement.owedCents).toBe(15100);
  });

  it("needs no choice when nothing comes back (an exchange the customer pays for)", async () => {
    basketLines.value = [line(1, 5000, 9000)];
    const p = await proposeCurrentSelection("o1", null, "CORREOS");
    expect(p?.agreement.owedCents).toBe(0);
    expect(proposeSubmission).toHaveBeenCalledOnce();
  });

  it("answers submission-in-progress when another proposal won the race", async () => {
    basketLines.value = [line(1, 7800)];
    proposeSubmission.mockResolvedValue({ ok: false, conflict: true });
    expect(await propose(vid("o1"), false, "CORREOS")).toEqual({ ok: false, reason: "submission-in-progress" });
  });

  it("answers nothing-selected for an empty basket", async () => {
    basketLines.value = [];
    expect(await propose(vid("o1"), false, "CORREOS")).toEqual({ ok: false, reason: "nothing-selected" });
  });
});
