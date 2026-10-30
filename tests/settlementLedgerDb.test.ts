import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";
import { planFor, seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";
import { giftCardObject, orderObject, refundObject, returnObject } from "./support/shopifyEvidence";

// The ledger's SQL, run for real against migrations 0004/0006/0007 in PGlite:
// admission, the claim → dispatch → record fences, finalization, the
// unresolved state + its alert, replacement funding, and recovery. Shopify is
// the only thing mocked — at the transport (lib/settlement/shopify.ts).

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
const env = settlementDatabase();
vi.mock("@/db/drizzle", () => ({ default: env.db, transact: (s: any) => env.transact(s) }));

/** Operation name → what Shopify answers. Unlisted = no answer. */
const answers: Record<string, (variables: any) => any> = {};
const sent: Array<{ name: string; variables: any }> = [];
vi.mock("@/lib/settlement/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settlement/shopify")>();
  return {
    ...actual,
    shopifyGraphQL: async (query: string, variables: any) => {
      const name = /(?:query|mutation) (\w+)/.exec(query)![1];
      sent.push({ name, variables });
      const answer = answers[name];
      return answer ? { kind: "answer", body: answer(variables) } : { kind: "no-answer", error: "timeout" };
    },
  };
});
vi.mock("@/actions/opsAlertOutbox", () => ({ enqueueOpsAlerts: async () => ({ failed: 0 }) }));

const ledger = () => import("@/lib/settlement/ledger");
const runner = () => import("@/lib/settlement/run");

const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;
const opState = async (id: string) => (await q("SELECT * FROM settlement_operations WHERE id=$1", [id]))[0];

async function admitted(seedOpts: Parameters<typeof seedSubmission>[1] = {}, planOver: any = {}) {
  const seeded = await seedSubmission(env.pg, seedOpts);
  const plan = planFor(seeded, planOver);
  const { insertAdmission } = await ledger();
  const result = await insertAdmission({
    submissionId: seeded.id,
    seenSeq: 0,
    ops: plan.ops,
    reverseFulfillment: plan.reverseFulfillment,
  });
  return { seeded, plan, result };
}

beforeAll(() => env.ready);
beforeEach(async () => {
  await env.reset();
  for (const k of Object.keys(answers)) delete answers[k];
  sent.length = 0;
});

describe("admission — one statement", () => {
  it("takes the submission for settlement and writes every operation", async () => {
    const { seeded, plan, result } = await admitted();
    expect(result).toEqual({ admitted: true, inserted: plan.ops.length });
    const s = (await q("SELECT * FROM return_submissions WHERE id=$1", [seeded.id]))[0];
    expect(s.holder).toBe("settlement");
    expect(s.admission_seq).toBe(1);
    const ops = await q("SELECT kind, members, state FROM settlement_operations");
    expect(ops).toEqual([{ kind: "process_refund", members: [1], state: "pending" }]);
  });

  it("freezes the reverse-fulfillment line on the submission line", async () => {
    const { seeded } = await admitted();
    const sl = (await q("SELECT * FROM submission_lines WHERE submission_id=$1", [seeded.id]))[0];
    expect(sl.reverse_fulfillment_line_item_id).toBe("gid://shopify/ReverseFulfillmentOrderLineItem/1");
  });

  it("writes nothing on a stale admission_seq — a concurrent admission won", async () => {
    const { seeded, plan } = await admitted();
    const { insertAdmission } = await ledger();
    const again = await insertAdmission({
      submissionId: seeded.id,
      seenSeq: 0,
      ops: plan.ops.map((o) => ({ ...o, id: randomUUID(), scope_key: `${o.scope_key}:x` })),
      reverseFulfillment: [],
    });
    expect(again).toEqual({ admitted: false, inserted: 0 });
    expect(await q("SELECT id FROM settlement_operations")).toHaveLength(1);
  });

  it("never writes an effect twice: the scope key is unique", async () => {
    const { seeded, plan } = await admitted();
    const { insertAdmission } = await ledger();
    const again = await insertAdmission({
      submissionId: seeded.id,
      seenSeq: 1,
      ops: plan.ops.map((o) => ({ ...o, id: randomUUID() })),
      reverseFulfillment: [],
    });
    expect(again).toEqual({ admitted: true, inserted: 0 });
  });

  it("is refused while cancellation holds the submission", async () => {
    const seeded = await seedSubmission(env.pg);
    const { claimForCancellation } = await import("@/lib/submissionCancellation");
    expect(await claimForCancellation(seeded.id)).toBe(true);
    const { insertAdmission } = await ledger();
    const plan = planFor(seeded);
    expect(
      await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] })
    ).toEqual({ admitted: false, inserted: 0 });
  });

  it("cancellation never claims a submission that has operations, whatever its holder says", async () => {
    const { seeded } = await admitted();
    await env.pg.query("UPDATE return_submissions SET holder = NULL WHERE id=$1", [seeded.id]);
    const { claimForCancellation } = await import("@/lib/submissionCancellation");
    expect(await claimForCancellation(seeded.id)).toBe(false);
  });

  it("leaves cancellation nothing to claim once anything is admitted", async () => {
    const { seeded } = await admitted();
    const { claimForCancellation } = await import("@/lib/submissionCancellation");
    expect(await claimForCancellation(seeded.id)).toBe(false);
  });
});

describe("claim → dispatch → record, fenced on (owner, lease_gen)", () => {
  it("a second claimer gets nothing while the lease is alive", async () => {
    const { plan } = await admitted();
    const { claim } = await ledger();
    expect(await claim(plan.ops[0].id, randomUUID())).not.toBeNull();
    expect(await claim(plan.ops[0].id, randomUUID())).toBeNull();
  });

  it("only the claim's owner, at its attempt, can dispatch", async () => {
    const { plan } = await admitted();
    const { claim, dispatch } = await ledger();
    const me = randomUUID();
    const claimed = (await claim(plan.ops[0].id, me))!;
    expect(await dispatch(claimed, randomUUID())).toBeNull();
    expect(await dispatch({ ...claimed, leaseGen: claimed.leaseGen + 1 }, me)).toBeNull();
    expect(await dispatch(claimed, me)).not.toBeNull();
  });

  it("an expired claim is taken over, and the old owner's dispatch and record are refused", async () => {
    const { plan } = await admitted();
    const { claim, dispatch, recordDone } = await ledger();
    const old = randomUUID();
    const first = (await claim(plan.ops[0].id, old))!;
    await env.pg.query("UPDATE settlement_operations SET lease_until = now() - interval '1 minute'");
    const second = (await claim(plan.ops[0].id, randomUUID()))!;
    // It never dispatched: same financial attempt, a new worker generation.
    expect(second.attempt).toBe(first.attempt);
    expect(second.leaseGen).toBe(first.leaseGen + 1);
    expect(await dispatch(first, old)).toBeNull();
    const done = await recordDone(first, { state: "dispatched", owner: old, leaseGen: first.leaseGen }, "x", {});
    expect(done.done).toBe(false);
  });

  it("does not claim an op whose dependency is not done", async () => {
    const V = "gid://shopify/ProductVariant/11";
    const { plan } = await admitted(
      { lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] },
      { reservation: { draftOrderId: "gid://shopify/DraftOrder/5", existed: true } }
    );
    const hold = plan.ops.find((o) => o.kind === "release_hold")!;
    const { claim } = await ledger();
    expect(await claim(hold.id, randomUUID())).toBeNull();
  });
});

describe("ownership changes never touch the financial attempt (finding 1)", () => {
  /** A root refund sent once with no answer, then taken over by a recovery
   *  that died before re-sending, its lease now expired. */
  async function takeoverDiedBeforeResend() {
    const seeded = await seedSubmission(env.pg, { residualCents: 1 });
    const plan = planFor(seeded);
    const { insertAdmission, getOperation, takeOver } = await ledger();
    await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] });
    const op = plan.ops.find((o) => o.scope_key.startsWith("residual:"))! as any;
    expect(op.kind).toBe("root_refund");
    expect(await (await runner()).run(op.id)).toBe("in-flight");
    const firstDispatch = (await opState(op.id)).dispatched_at;
    await env.pg.query("UPDATE settlement_operations SET updated_at = now() - interval '1 hour'");
    const taken = (await takeOver((await getOperation(op.id))!, randomUUID()))!;
    expect(taken.attempt).toBe(1);
    await env.pg.query("UPDATE settlement_operations SET lease_until = now() - interval '1 minute'");
    return { op, firstDispatch };
  }
  const refundKeys = () => sent.filter((s) => s.name === "SettlementRefundCreate").map((s) => s.variables.idempotencyKey);

  it("an expired claim that had dispatched cannot be claimed afresh", async () => {
    const { op } = await takeoverDiedBeforeResend();
    expect(await (await ledger()).claim(op.id, randomUUID())).toBeNull();
    const row = await opState(op.id);
    expect(row.attempt).toBe(1);
    expect(row.dispatched_at).not.toBeNull();
  });

  it("recovery re-enters evidence: the first request landed, so it is done and nothing is re-sent", async () => {
    const { op } = await takeoverDiedBeforeResend();
    answers.SettlementOrderRefunds = () => ({ data: { order: { refunds: [refundObject(op.request.check)] } } });
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    const report = await recoverSettlements({ deadline: Date.now() + 60_000 });
    expect(report.ran).toContainEqual({ op: op.id, kind: "root_refund", from: "claimed", result: "done" });
    expect(refundKeys()).toEqual([`${op.id}:1`]);
  });

  it("with no refund in evidence, the replay carries the ORIGINAL key and first-dispatch time", async () => {
    const { op, firstDispatch } = await takeoverDiedBeforeResend();
    answers.SettlementOrderRefunds = () => ({ data: { order: { refunds: [] } } });
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    await recoverSettlements({ deadline: Date.now() + 60_000 });
    expect(refundKeys()).toEqual([`${op.id}:1`, `${op.id}:1`]);
    const row = await opState(op.id);
    expect(row.attempt).toBe(1);
    expect(new Date(row.dispatched_at).getTime()).toBe(new Date(firstDispatch).getTime());
  });

  it("a rejection is the only thing that starts a new attempt", async () => {
    const seeded = await seedSubmission(env.pg, { residualCents: 1 });
    const plan = planFor(seeded);
    const { insertAdmission, claim } = await ledger();
    await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] });
    const op = plan.ops.find((o) => o.scope_key.startsWith("residual:"))! as any;
    answers.SettlementRefundCreate = () => ({ data: { refundCreate: { refund: null, userErrors: [{ message: "no" }] } } });
    expect(await (await runner()).run(op.id)).toBe("rejected");
    const again = (await claim(op.id, randomUUID()))!;
    expect(again.attempt).toBe(2);
    expect(again.dispatchedAt).toBeNull();
  });
});

describe("finalization", () => {
  it("settles a line only when EVERY op it needs is done — goods alone settle nothing", async () => {
    const { seeded, plan } = await admitted({ tender: "credit" });
    const goods = plan.ops.find((o) => o.kind === "process_goods")! as any;
    const card = plan.ops.find((o) => o.kind === "gift_card")! as any;
    answers.SettlementReturnProcess = () => ({
      data: { returnProcess: { return: returnObject(goods.request.check), userErrors: [] } },
    });
    const { run } = await runner();
    expect(await run(goods.id)).toBe("done");
    expect((await q("SELECT settled_at FROM submission_lines WHERE submission_id=$1", [seeded.id]))[0].settled_at).toBeNull();
    expect((await q("SELECT refunded FROM productsorder WHERE id=1"))[0].refunded).toBeNull();

    answers.SettlementGiftCardCreate = () => ({
      data: { giftCardCreate: { giftCard: giftCardObject(card.request.check), userErrors: [] } },
    });
    expect(await run(card.id)).toBe("done");
    expect((await q("SELECT settled_at FROM submission_lines WHERE submission_id=$1", [seeded.id]))[0].settled_at).not.toBeNull();
    expect((await q("SELECT refunded FROM productsorder WHERE id=1"))[0].refunded).toBe(true);
  });

  it("finalizes once: a second finalize settles nothing new", async () => {
    const { seeded, plan } = await admitted();
    const op = plan.ops[0] as any;
    answers.SettlementReturnProcess = () => ({
      data: { returnProcess: { return: returnObject(op.request.check), userErrors: [] } },
    });
    await (await runner()).run(op.id);
    const { finalize } = await ledger();
    expect(await finalize(seeded.id)).toEqual([]);
  });

  it("a line is not paid, nor the return refunded, while the residual is still owed (finding 7)", async () => {
    const seeded = await seedSubmission(env.pg, { lines: [line(1), line(2)], residualCents: 1 });
    const plan = planFor(seeded);
    const { insertAdmission } = await ledger();
    await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] });
    const residual = plan.ops.find((o) => o.scope_key.startsWith("residual:"))! as any;
    expect(residual.members).toEqual([1, 2]);
    for (const op of plan.ops.filter((o) => o.kind === "process_refund") as any[]) {
      answers.SettlementReturnProcess = () => ({
        data: { returnProcess: { return: returnObject(op.request.check), userErrors: [] } },
      });
      expect(await (await runner()).run(op.id)).toBe("done");
    }
    // Both line effects are done; the one-cent residual is still pending.
    expect(await q("SELECT settled_at FROM submission_lines WHERE settled_at IS NOT NULL")).toEqual([]);
    expect(await q("SELECT id FROM productsorder WHERE refunded")).toEqual([]);
    const { lineStatus } = await import("@/lib/settlement/settle");
    const ops = await (await ledger()).operationsOf(seeded.id);
    expect([1, 2].map((id) => lineStatus(id, null, ops))).toEqual(["in-flight", "in-flight"]);

    answers.SettlementRefundCreate = () => ({
      data: { refundCreate: { refund: refundObject(residual.request.check), userErrors: [] } },
    });
    expect(await (await runner()).run(residual.id)).toBe("done");
    expect((await q("SELECT id FROM productsorder WHERE refunded ORDER BY id")).map((r) => r.id)).toEqual([1, 2]);
  });

  it("pays the residual exactly once, across two admissions", async () => {
    const seeded = await seedSubmission(env.pg, { lines: [line(1), line(2)], residualCents: 1 });
    const { insertAdmission } = await ledger();
    const first = planFor(seeded, { admit: [1] });
    await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: first.ops, reverseFulfillment: [] });
    const second = planFor(seeded, {
      existing: first.ops.map((o) => ({ id: o.id, kind: o.kind, scopeKey: o.scope_key })),
    });
    await insertAdmission({ submissionId: seeded.id, seenSeq: 1, ops: second.ops, reverseFulfillment: [] });
    const third = planFor(seeded, {
      existing: [...first.ops, ...second.ops].map((o) => ({ id: o.id, kind: o.kind, scopeKey: o.scope_key })),
    });
    await insertAdmission({ submissionId: seeded.id, seenSeq: 2, ops: third.ops, reverseFulfillment: [] });
    expect(await q("SELECT amount_cents FROM settlement_operations WHERE scope_key LIKE 'residual:%'")).toEqual([
      { amount_cents: 1 },
    ]);
  });
});

describe("an operation only a human can decide", () => {
  it("records `unresolved` and its durable alert in one statement, once", async () => {
    const { plan } = await admitted();
    const op = plan.ops[0] as any;
    // Goods processed but no money: one returnProcess cannot do half.
    answers.SettlementReturnProcess = () => ({
      data: { returnProcess: { return: returnObject(op.request.check, { refunds: [] }), userErrors: [] } },
    });
    expect(await (await runner()).run(op.id)).toBe("unresolved");
    expect((await opState(op.id)).state).toBe("unresolved");
    const alerts = await q("SELECT dedupe_key, body FROM ops_alerts");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupe_key).toBe(`settlement-unresolved:${op.id}`);
    expect(alerts[0].body).toContain("scripts/resolve-operation.ts");
    // Nothing claims it again.
    expect(await (await ledger()).claim(op.id, randomUUID())).toBeNull();
  });

  it("an operator's decision is fenced on the unresolved state", async () => {
    const { plan } = await admitted();
    const op = plan.ops[0] as any;
    const { recordDone, getOperation } = await ledger();
    await env.pg.query("UPDATE settlement_operations SET state='unresolved' WHERE id=$1", [op.id]);
    const current = (await getOperation(op.id))!;
    const r = await recordDone(current, { state: "unresolved" }, "gid://shopify/Refund/1", { by: "ops" }, { resolvedBy: "santi" });
    expect(r.done).toBe(true);
    expect((await opState(op.id)).resolved_by).toBe("santi");
    expect((await recordDone(current, { state: "unresolved" }, "x", {})).done).toBe(false);
  });
});

describe("the exchange order", () => {
  const V = "gid://shopify/ProductVariant/11";

  it("writes replacement_lines with the done state, and a return of it is priced from them", async () => {
    const { plan } = await admitted({
      lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0, quantity: 2, returnedCents: 7000, stripeFundedCents: 1250 })],
    });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    answers.SettlementOrderCreate = () => ({
      data: { orderCreate: { order: orderObject(op.request.check), userErrors: [] } },
    });
    expect(await (await runner()).run(op.id)).toBe("done");
    expect(await q("SELECT order_id, line_item_id, quantity, stripe_funded_cents FROM replacement_lines")).toEqual([
      { order_id: "555", line_item_id: "gid://shopify/LineItem/900", quantity: 2, stripe_funded_cents: 1250 },
    ]);
    const { replacementFundingOf } = await import("@/db/replacementLines");
    // Found through the op id the order carries as its sourceIdentifier.
    const found = await replacementFundingOf({ id: "555", sourceIdentifier: op.id });
    // 7000 returned + 1250 card, kept as the exact line total over its 2 units.
    expect(found).toEqual({
      kind: "funded",
      funding: {
        sourceOrderId: "100",
        lineByLineItem: new Map([["gid://shopify/LineItem/900", { totalCents: 8250, quantity: 2 }]]),
      },
    });
  });

  it("an exchange order cannot be recorded done without its replacement lines (finding 5)", async () => {
    const { plan } = await admitted({ lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    await env.pg.query("UPDATE settlement_operations SET state='unresolved' WHERE id=$1", [op.id]);
    const { getOperation, recordDone } = await ledger();
    const current = (await getOperation(op.id))!;
    await expect(recordDone(current, { state: "unresolved" }, "gid://shopify/Order/555", {})).rejects.toThrow(
      /replacement lines/
    );
    expect((await opState(op.id)).state).toBe("unresolved");
  });

  it("an operator's done reads the named order from Shopify and records its real lines (finding 5)", async () => {
    const { plan } = await admitted({
      lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0, returnedCents: 3101, quantity: 2 })],
    });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    await env.pg.query("UPDATE settlement_operations SET state='unresolved' WHERE id=$1", [op.id]);
    const { getOperation } = await ledger();
    const { resolveOperation } = await import("@/lib/settlement/operator");
    const decision = { verdict: "done" as const, evidence: "found it", by: "santi" };

    expect(await resolveOperation((await getOperation(op.id))!, decision, { write: true })).toEqual({
      ok: false,
      reason: "exchange_order needs --order <gid of the order you found>",
    });
    // An order that is not this op's (another sourceIdentifier) is refused.
    answers.SettlementExchangeOrderById = () => ({
      data: { order: { ...orderObject(op.request.check), sourceIdentifier: "someone-else" } },
    });
    const wrong = await resolveOperation((await getOperation(op.id))!, { ...decision, orderGid: "gid://shopify/Order/555" }, { write: true });
    expect(wrong.ok).toBe(false);
    expect((await opState(op.id)).state).toBe("unresolved");

    answers.SettlementExchangeOrderById = () => ({ data: { order: orderObject(op.request.check) } });
    const right = await resolveOperation((await getOperation(op.id))!, { ...decision, orderGid: "gid://shopify/Order/555" }, { write: true });
    expect(right).toMatchObject({ ok: true, written: true });
    expect(await q("SELECT order_id, line_item_id, source_productsorder_id, quantity FROM replacement_lines")).toEqual([
      { order_id: "555", line_item_id: "gid://shopify/LineItem/900", source_productsorder_id: 1, quantity: 2 },
    ]);
    expect((await opState(op.id)).resolved_by).toBe("santi");
  });

  it("an operator's done of a hold release clears the order's reservation pointer (finding 5)", async () => {
    const D = "gid://shopify/DraftOrder/5";
    const { seeded, plan } = await admitted(
      { lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] },
      { reservation: { draftOrderId: D, existed: true } }
    );
    await env.pg.query("UPDATE orders SET exchange_reservation_id=$1 WHERE id=$2", [D, seeded.orderId]);
    const hold = plan.ops.find((o) => o.kind === "release_hold")! as any;
    await env.pg.query("UPDATE settlement_operations SET state='unresolved' WHERE id=$1", [hold.id]);
    const { getOperation } = await ledger();
    const { resolveOperation } = await import("@/lib/settlement/operator");
    answers.SettlementDraftOrder = () => ({ data: { draftOrder: { id: D } } });
    const decision = { verdict: "done" as const, evidence: "deleted by hand", by: "santi" };
    expect((await resolveOperation((await getOperation(hold.id))!, decision, { write: true })).ok).toBe(false);
    answers.SettlementDraftOrder = () => ({ data: { draftOrder: null } });
    expect(await resolveOperation((await getOperation(hold.id))!, decision, { write: true })).toMatchObject({ ok: true });
    expect((await q("SELECT exchange_reservation_id FROM orders WHERE id=$1", [seeded.orderId]))[0].exchange_reservation_id).toBeNull();
  });

  it("an S2 order whose records are missing is never valued from tags (finding 5)", async () => {
    const { plan } = await admitted({ lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    const { replacementFundingOf } = await import("@/db/replacementLines");
    expect(await replacementFundingOf({ id: "555", sourceIdentifier: op.id })).toEqual({
      kind: "unfunded",
      sourceOrderId: "100",
      reason: "exchange-operation-pending",
    });
    // Done with no lines can only happen by a raw write — still never "legacy".
    await env.pg.query("UPDATE settlement_operations SET state='done' WHERE id=$1", [op.id]);
    expect(await replacementFundingOf({ id: "555", sourceIdentifier: op.id })).toMatchObject({
      kind: "unfunded",
      reason: "no-replacement-lines",
    });
    expect(await replacementFundingOf({ id: "555", sourceIdentifier: null })).toEqual({ kind: "not-settlement" });
  });

  it("ships exactly the frozen quantity: an order with a different quantity is never done", async () => {
    const { plan } = await admitted({ lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0, quantity: 2 })] });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    expect(op.request.variables.order.lineItems[0].quantity).toBe(2);
    answers.SettlementOrderCreate = () => ({
      data: { orderCreate: { order: orderObject(op.request.check, { quantityDelta: -1 }), userErrors: [] } },
    });
    expect(await (await runner()).run(op.id)).toBe("unresolved");
    expect(await q("SELECT * FROM replacement_lines")).toEqual([]);
  });

  it("can never be taken over for a re-send, however stale", async () => {
    const { plan } = await admitted({ lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    expect(await (await runner()).run(op.id)).toBe("in-flight");
    await env.pg.query("UPDATE settlement_operations SET updated_at = now() - interval '1 day'");
    const { getOperation, takeOver } = await ledger();
    expect(await takeOver((await getOperation(op.id))!, randomUUID())).toBeNull();
  });

  it("is never re-sent by recovery — an unanswered order is only ever searched for", async () => {
    const { plan } = await admitted({ lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    expect(await (await runner()).run(op.id)).toBe("in-flight");
    await env.pg.query("UPDATE settlement_operations SET updated_at = now() - interval '1 hour'");
    answers.SettlementExchangeOrderEvidence = () => ({ data: { orders: { nodes: [] } } });
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    await recoverSettlements({ deadline: Date.now() + 60_000 });
    expect(sent.filter((s) => s.name === "SettlementOrderCreate")).toHaveLength(1);
    expect((await opState(op.id)).state).toBe("unresolved");
  });
});

describe("recovery", () => {
  it("finishes a dispatched op from Shopify's evidence even with auto-approve OFF and the return CLOSED", async () => {
    process.env.AUTO_APPROVE_ENABLED = "false";
    const { seeded, plan } = await admitted();
    const op = plan.ops[0] as any;
    expect(await (await runner()).run(op.id)).toBe("in-flight");
    await env.pg.query("UPDATE settlement_operations SET updated_at = now() - interval '1 hour'");
    answers.SettlementReturnEvidence = () => ({ data: { return: returnObject(op.request.check) } });
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    const report = await recoverSettlements({ deadline: Date.now() + 60_000 });
    expect(report.ran).toEqual([{ op: op.id, kind: "process_refund", from: "dispatched", result: "done" }]);
    expect((await q("SELECT refunded FROM productsorder WHERE id=1"))[0].refunded).toBe(true);
    // Recovery judged from evidence; it did not send the mutation again.
    expect(sent.filter((s) => s.name === "SettlementReturnProcess")).toHaveLength(1);
    expect((await q("SELECT settled_at FROM submission_lines WHERE submission_id=$1", [seeded.id]))[0].settled_at).not.toBeNull();
  });

  it("re-runs a REJECTED money op with no admission at all, and alerts on the refusal once (finding 4)", async () => {
    process.env.AUTO_APPROVE_ENABLED = "false";
    const { seeded, plan } = await admitted({ tender: "credit" });
    const goods = plan.ops.find((o) => o.kind === "process_goods")! as any;
    const card = plan.ops.find((o) => o.kind === "gift_card")! as any;
    answers.SettlementReturnProcess = () => ({
      data: { returnProcess: { return: returnObject(goods.request.check), userErrors: [] } },
    });
    answers.SettlementGiftCardCreate = () => ({
      data: { giftCardCreate: { giftCard: null, userErrors: [{ code: "INVALID", message: "try later" }] } },
    });
    const { run } = await runner();
    expect(await run(goods.id)).toBe("done"); // the return is now CLOSED in Shopify
    expect(await run(card.id)).toBe("rejected");
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    await recoverSettlements({ deadline: Date.now() + 60_000 }); // refused again
    expect((await q("SELECT dedupe_key FROM ops_alerts")).map((a) => a.dedupe_key)).toEqual([
      `settlement-rejected:${card.id}`,
    ]);
    answers.SettlementGiftCardCreate = () => ({
      data: { giftCardCreate: { giftCard: giftCardObject(card.request.check), userErrors: [] } },
    });
    const report = await recoverSettlements({ deadline: Date.now() + 60_000 });
    expect(report.ran).toContainEqual({ op: card.id, kind: "gift_card", from: "rejected", result: "done" });
    expect((await q("SELECT settled_at FROM submission_lines WHERE submission_id=$1", [seeded.id]))[0].settled_at).not.toBeNull();
  });

  it("finalizes a submission whose op is done but whose line was never stamped", async () => {
    const { seeded, plan } = await admitted();
    await env.pg.query("UPDATE settlement_operations SET state='done' WHERE id=$1", [plan.ops[0].id]);
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    const report = await recoverSettlements({ deadline: Date.now() + 60_000 });
    expect(report.finalized).toEqual([{ submission: seeded.id, lines: [1] }]);
  });
});

describe("ownership of the rows (S2 plan L2)", () => {
  it("a portal edit cannot touch a row inside a submission settlement holds", async () => {
    await admitted();
    const { rowNotHeldBySettlement } = await import("@/lib/submissionCancellation");
    const { sql } = await import("drizzle-orm");
    await env.db.execute(
      sql`UPDATE productsorder SET reason = 'edited' WHERE id = 1 AND ${rowNotHeldBySettlement(sql`productsorder`)}`
    );
    expect((await q("SELECT reason FROM productsorder WHERE id=1"))[0].reason).toBeNull();
  });

  it("a cancellation finishes in one transaction: cancelled, and the rows reset", async () => {
    const seeded = await seedSubmission(env.pg);
    const c = await import("@/lib/submissionCancellation");
    expect(await c.claimForCancellation(seeded.id)).toBe(true);
    await c.finishCancellation(seeded.orderId, [seeded.id]);
    expect((await q("SELECT state FROM return_submissions WHERE id=$1", [seeded.id]))[0].state).toBe("cancelled");
    expect((await q("SELECT confirmed, return_line_item_id FROM productsorder WHERE id=1"))[0]).toEqual({
      confirmed: false,
      return_line_item_id: null,
    });
  });

  it("releasing a cancellation gives settlement the submission back", async () => {
    const seeded = await seedSubmission(env.pg);
    const c = await import("@/lib/submissionCancellation");
    await c.claimForCancellation(seeded.id);
    await c.releaseCancellation(seeded.id);
    expect((await q("SELECT holder FROM return_submissions WHERE id=$1", [seeded.id]))[0].holder).toBeNull();
  });
});
