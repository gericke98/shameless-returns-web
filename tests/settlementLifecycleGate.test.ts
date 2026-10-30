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

// S3, Santi 30 Oct: a payment he approved (a settlement_approvals row, 0010)
// is the explicit finding that nothing was settled outside the ledger, so it
// replaces the OPEN gate for that line only. Goods are planned only where
// Shopify can still process them; anything else would be refused forever.
describe("an approved legacy payment passes the OPEN gate on its approval alone", () => {
  const approved = (po: number, amountCents = 4500, basis = "unpaid") =>
    new Map([[po, { amountCents, basis }]]);
  const processed = (lines: ReturnType<typeof line>[], status: string, processedQuantity: number) => {
    const f = returnFacts(lines, { status });
    for (const [k, v] of Array.from(f.returnLines)) f.returnLines.set(k, { ...v, processedQuantity });
    return f;
  };
  const plan = (status: string, processedQuantity: number, over: Parameters<typeof planInput>[1] = {}, lines = [line(1)]) => {
    const input = planInput(lines, over);
    input.returns.set(RETURN, processed(lines, status, processedQuantity));
    return planAdmission(input);
  };
  const kinds = (p: ReturnType<typeof planAdmission>) => (p.ok ? p.ops.map((o) => o.kind) : p);

  it.each(["CLOSED", "CANCELED", "DECLINED"])("%s return, processed line: one refund on the order, no goods", (status) => {
    const p = plan(status, 1, { approved: approved(1) });
    expect(kinds(p)).toEqual(["root_refund"]);
    expect(p.ok && p.ops[0].amount_cents).toBe(4500);
  });

  it("CLOSED return, line never processed: still no goods (Shopify cannot process a closed return)", () => {
    expect(kinds(plan("CLOSED", 0, { approved: approved(1) }))).toEqual(["root_refund"]);
  });

  it("OPEN return, line already processed: no goods operation", () => {
    expect(kinds(plan("OPEN", 1, { approved: approved(1) }))).toEqual(["root_refund"]);
  });

  it("OPEN return, line unprocessed: goods with no money in them, and the money outside", () => {
    const p = plan("OPEN", 0, { approved: approved(1) });
    expect(kinds(p)).toEqual(["process_goods", "root_refund"]);
    const goods = p.ok ? (p.ops[0].request as any).variables.input : null;
    expect(goods.financialTransfer).toBeUndefined();
    expect(goods.returnLineItems[0].dispositions[0].dispositionType).toBe("NOT_RESTOCKED");
  });

  it("a partly processed line waits for a human", () => {
    const l = line(1, { quantity: 2, payCents: 4500 });
    expect(plan("OPEN", 1, { approved: approved(1) }, [l])).toEqual({ ok: false, held: "approval-partly-processed:1" });
  });

  it("credit tender: a gift card for exactly the amount", () => {
    const submission = { ...planInput([]).submission, tender: "credit" as const };
    const p = plan("CLOSED", 1, { approved: approved(1), submission });
    expect(kinds(p)).toEqual(["gift_card"]);
    expect(p.ok && p.ops[0].amount_cents).toBe(4500);
  });

  it("the line must pay exactly the approved amount", () => {
    expect(plan("CLOSED", 1, { approved: approved(1, 4400) })).toEqual({ ok: false, held: "approval-amount:1" });
  });

  it("an approved CAMBIO is money only: never a second replacement order", () => {
    const cambio = line(1, { action: "CAMBIO", newVariantId: "gid://shopify/ProductVariant/11", payCents: 2000 });
    expect(kinds(plan("CLOSED", 1, { approved: approved(1, 2000, "swap") }, [cambio]))).toEqual(["root_refund"]);
  });

  it("only the approved line passes: an unapproved one beside it is still held", () => {
    const p = plan("CLOSED", 1, { approved: approved(1) }, [line(1), line(2)]);
    expect(p).toEqual({ ok: false, held: "return-not-open:CLOSED" });
  });
});
