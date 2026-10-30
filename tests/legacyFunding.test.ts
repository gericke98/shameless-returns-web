import { describe, expect, it } from "vitest";
import { legacyFundingOf, type StripeSession } from "@/lib/settlement/legacyFunding";
import { nullActionDiagnostics, pendingNullActionLines } from "@/lib/settlement/reconcile";

// Codex #5: a pre-ledger exchange line's funding comes only from the real
// Stripe payments. A paid session carries no split to a line, so only the
// proven ABSENCE of payment (complete listing, nothing unattributed) gives a
// funding: 0. Everything else is unresolved — never computed.

const session = (id: string, meta: Record<string, string> | null, status = "paid"): StripeSession => ({
  id,
  payment_status: status,
  metadata: meta,
});
const none = new Map();
const noLine = () => null;

describe("legacyFundingOf", () => {
  it("no paid legacy session for the order, complete listing → funded 0, from Stripe", () => {
    const s = { ok: true as const, sessions: [session("cs_a", { id: "200" }), session("cs_b", { id: "100" }, "unpaid")] };
    expect(legacyFundingOf("100", s, none, noLine)).toMatchObject({ ok: true, stripeFundedCents: 0 });
  });
  it("a paid session for the order → unresolved: no recorded split to the line", () => {
    const s = { ok: true as const, sessions: [session("cs_a", { id: "100" })] };
    expect(legacyFundingOf("100", s, none, noLine)).toMatchObject({ ok: false, reason: expect.stringContaining("cs_a") });
  });
  it("S1 sessions (with a submission id) are not legacy and never count", () => {
    const s = { ok: true as const, sessions: [session("cs_a", { id: "100", submission_id: "5ub" })] };
    expect(legacyFundingOf("100", s, none, noLine).ok).toBe(true);
  });
  it("a paid session naming no order blocks every order until a human binds or excludes it", () => {
    const s = { ok: true as const, sessions: [session("cs_x", null)] };
    expect(legacyFundingOf("100", s, none, noLine)).toMatchObject({ ok: false, reason: expect.stringContaining("cs_x") });
    const excluded = new Map([["cs_x", { verdict: "excludes" as const, productsorderId: null }]]);
    expect(legacyFundingOf("100", s, excluded, noLine).ok).toBe(true);
    const bound = new Map([["cs_x", { verdict: "binds" as const, productsorderId: 7 }]]);
    expect(legacyFundingOf("100", s, bound, (po) => (po === 7 ? "100" : null)).ok).toBe(false);
    expect(legacyFundingOf("200", s, bound, (po) => (po === 7 ? "100" : null)).ok).toBe(true);
  });
  it("an unreadable or incomplete listing → unresolved", () => {
    expect(legacyFundingOf("100", { ok: false, error: "timeout" }, none, noLine).ok).toBe(false);
  });
});

describe("pending NULL-action lines, read-only (Codex #8)", () => {
  const f = (over: any) => ({ refunded: false, action: null, returnId: "gid://shopify/Return/1", ...over });
  it("lists pending NULL-action lines on a return — not settled ones, not ones with an action, not ones with no return", () => {
    const lines = [f({ id: 1 }), f({ id: 2, refunded: true }), f({ id: 3, action: "CAMBIO" }), f({ id: 4, returnId: null })];
    expect(pendingNullActionLines(lines).map((l: any) => l.id)).toEqual([1]);
  });
  it("shows the refunds naming the line, the exchange orders and native lines", () => {
    const d = nullActionDiagnostics(
      { lineItemId: "777" },
      {
        ok: true,
        value: {
          id: "r",
          status: "OPEN",
          order: null,
          refunds: { nodes: [{ id: "R1", refundLineItems: { nodes: [{ lineItem: { id: "gid://shopify/LineItem/777" } }] } }] },
          exchangeLineItems: { nodes: [] },
        },
      },
      { ok: true, value: { truncated: false, nodes: [{ id: "o", name: "#500" }] } }
    );
    expect(d).toEqual({ returnStatus: "OPEN", refunds: "R1", exchangeOrders: "#500", nativeExchangeLines: "0" });
  });
});
