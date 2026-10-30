import { describe, expect, it } from "vitest";
import { planAdmission, scopeKeys } from "@/lib/settlement/plan";
import { line, planInput, returnFacts, RETURN, SUB } from "./support/planFixtures";

// Finding 2: Shopify's return lifecycle gates every NEW obligation. Every
// admission entry point (dashboard `validateReturn`, auto-approve) reaches
// effects only through `admit` → `planAdmission`, so the gate lives there:
// a return that is not OPEN was settled or withdrawn outside the ledger, and
// creating money against it could pay twice. Work admitted while it was OPEN
// stays executable after closure (recovery, see settlementLedgerDb.test.ts).

function onReturn(status: string, lines = [line(1)], over: Parameters<typeof planInput>[1] = {}) {
  const input = planInput(lines, over);
  input.returns.set(RETURN, returnFacts(lines, { status }));
  return planAdmission(input);
}

describe("admission creates obligations only against an OPEN Shopify return", () => {
  it("admits an OPEN return", () => {
    expect(onReturn("OPEN").ok).toBe(true);
  });

  it.each(["CLOSED", "CANCELED", "DECLINED", "REQUESTED"])("holds a %s return: no operation at all", (status) => {
    expect(onReturn(status)).toEqual({ ok: false, held: `return-not-open:${status}` });
  });

  it("holds a credit-tender line (gift card) on a CLOSED return", () => {
    expect(onReturn("CLOSED", [line(1)], { submission: { ...planInput([]).submission, tender: "credit" } })).toEqual({
      ok: false,
      held: "return-not-open:CLOSED",
    });
  });

  it("holds a replacement order's root refund on a CANCELED return", () => {
    expect(onReturn("CANCELED", [line(1)], { isReplacement: true })).toEqual({
      ok: false,
      held: "return-not-open:CANCELED",
    });
  });

  it("holds a new exchange order on a CLOSED return", () => {
    const cambio = line(1, { action: "CAMBIO", newVariantId: "gid://shopify/ProductVariant/11", payCents: 0 });
    expect(onReturn("CLOSED", [cambio])).toEqual({ ok: false, held: "return-not-open:CLOSED" });
  });

  it("re-admitting work that already exists is not a new obligation: nothing new, nothing held", () => {
    const existing = [
      { id: "op-a", kind: "process_refund" as const, scopeKey: scopeKeys.money(SUB, 1) },
    ];
    expect(onReturn("CLOSED", [line(1)], { existing })).toMatchObject({ ok: true, ops: [] });
  });

  it("holds the residual if it would be created after the return closed", () => {
    const existing = [{ id: "op-a", kind: "process_refund" as const, scopeKey: scopeKeys.money(SUB, 1) }];
    const submission = { ...planInput([]).submission, residualCents: 1 };
    expect(onReturn("CLOSED", [line(1)], { existing, submission })).toEqual({
      ok: false,
      held: "return-not-open:CLOSED",
    });
  });
});
