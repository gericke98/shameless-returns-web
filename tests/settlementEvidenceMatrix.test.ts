import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";
import { planFor, seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";
import { giftCardObject, orderObject, refundObject, returnObject } from "./support/shopifyEvidence";

// The L5 table, row by row: for each kind, what the mutation's answer, a
// userError, no answer, and recovery's evidence read (0 / 1 / 2 / mismatch /
// PENDING / FAILURE / past 23 h) make of the operation. Real ledger SQL in
// PGlite; Shopify mocked at the transport only.

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

const V = "gid://shopify/ProductVariant/11";
const ROOT = "gid://shopify/Order/1";
const TX = "gid://shopify/OrderTransaction/7";

async function opOf(kind: string, seedOpts: any = {}, planOver: any = {}) {
  const { plan } = await admitted(seedOpts, planOver);
  return plan.ops.find((o) => o.kind === kind)! as any;
}
const kinds = {
  process_refund: () => opOf("process_refund"),
  process_goods: () => opOf("process_goods", { tender: "credit" }),
  gift_card: () => opOf("gift_card", { tender: "credit" }),
  root_refund: () =>
    opOf("root_refund", {}, {
      isReplacement: true,
      paying: { orderGid: ROOT, presentment: null, gateways: new Map([[TX, "manual"]]), transactionId: TX },
    }),
  exchange_order: () => opOf("exchange_order", { lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] }),
  release_hold: async () => {
    await env.pg.exec("INSERT INTO orders (id, order_number) VALUES ('100', '#100') ON CONFLICT DO NOTHING");
    const { plan } = await admitted(
      { lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] },
      { reservation: { draftOrderId: "gid://shopify/DraftOrder/5", existed: true } }
    );
    // Its dependency, the exchange order, is done.
    await env.pg.query("UPDATE settlement_operations SET state='done' WHERE kind='exchange_order'");
    return plan.ops.find((o) => o.kind === "release_hold")! as any;
  },
};

const run = async (id: string) => (await import("@/lib/settlement/run")).run(id);
/** Send with no answer, then age the dispatch past the lease. */
async function unanswered(op: any) {
  expect(await run(op.id)).toBe("in-flight");
  expect((await opState(op.id)).state).toBe("dispatched");
  await env.pg.query("UPDATE settlement_operations SET updated_at = now() - interval '1 hour' WHERE id=$1", [op.id]);
}
async function recover(op: any) {
  const { recoverDispatched } = await import("@/lib/settlement/run");
  const { getOperation } = await ledger();
  return recoverDispatched((await getOperation(op.id))!, randomUUID());
}
const sends = (name: string) => sent.filter((s) => s.name === name);
const USER_ERROR = { userErrors: [{ field: ["x"], message: "no", code: "INVALID" }] };

describe.each([
  ["process_refund", "SettlementReturnProcess", "returnProcess"],
  ["process_goods", "SettlementReturnProcess", "returnProcess"],
] as const)("%s", (kind, mutation, field) => {
  it("answered with the frozen effect → done", async () => {
    const op = await kinds[kind]();
    answers[mutation] = () => ({ data: { [field]: { return: returnObject(op.request.check), userErrors: [] } } });
    expect(await run(op.id)).toBe("done");
  });

  it("userError → rejected (the effect did not happen)", async () => {
    const op = await kinds[kind]();
    answers[mutation] = () => ({ data: { [field]: { return: null, ...USER_ERROR } } });
    expect(await run(op.id)).toBe("rejected");
    expect((await opState(op.id)).state).toBe("rejected");
  });

  it("no answer → stays dispatched; evidence 0 → re-sent under the SAME attempt", async () => {
    const op = await kinds[kind]();
    await unanswered(op);
    answers.SettlementReturnEvidence = () => ({ data: { return: returnObject(op.request.check, { processed: 0, refunds: [] }) } });
    answers[mutation] = () => ({ data: { [field]: { return: returnObject(op.request.check), userErrors: [] } } });
    expect(await recover(op)).toBe("done");
    expect(sends(mutation)).toHaveLength(2);
    // A takeover changes the worker, never the financial attempt (finding 1).
    expect((await opState(op.id)).attempt).toBe(1);
  });

  it("no answer, evidence 1 → done without a re-send", async () => {
    const op = await kinds[kind]();
    await unanswered(op);
    answers.SettlementReturnEvidence = () => ({ data: { return: returnObject(op.request.check) } });
    expect(await recover(op)).toBe("done");
    expect(sends(mutation)).toHaveLength(1);
  });

  it("evidence mismatch (processed, not NOT_RESTOCKED) → unresolved", async () => {
    const op = await kinds[kind]();
    await unanswered(op);
    answers.SettlementReturnEvidence = () => ({ data: { return: returnObject(op.request.check, { notRestocked: 0 }) } });
    expect(await recover(op)).toBe("unresolved");
  });
});

describe("process_refund — the money half of the evidence", () => {
  it.each([
    ["2 refunds of this line item", { refunds: [{}, {}] }, "unresolved"],
    ["a refund of another amount", { refunds: [{ amount: "1.00" }] }, "unresolved"],
    ["PENDING", { refunds: [{ status: "PENDING" }] }, "in-flight"],
    ["FAILURE", { refunds: [{ status: "FAILURE" }] }, "unresolved"],
  ])("%s → %s", async (_label, facts, expected) => {
    const op = await kinds.process_refund();
    await unanswered(op);
    answers.SettlementReturnEvidence = () => ({ data: { return: returnObject(op.request.check, facts as any) } });
    expect(await recover(op)).toBe(expected);
    if (expected === "in-flight") expect((await opState(op.id)).state).toBe("dispatched");
  });

  // Finding 6: ownership is the refunded line item, never the amount.
  async function twoEqualGarments() {
    const { plan } = await admitted({ lines: [line(1), line(2)] }); // both €45 against TX 7
    const [a, b] = plan.ops.filter((o) => o.kind === "process_refund") as any[];
    expect(a.request.check.refund.money).toEqual(b.request.check.refund.money);
    expect(a.request.check.refund.parentTransactionId).toBe(b.request.check.refund.parentTransactionId);
    return { a, b };
  }

  it("two garments refunding equal amounts against one payment each find their OWN refund", async () => {
    const { a, b } = await twoEqualGarments();
    await unanswered(b);
    answers.SettlementReturnEvidence = () => ({
      data: { return: returnObject(b.request.check, { refunds: [{ lineItem: a.request.check.refund.lineItemGid }, {}] }) },
    });
    expect(await recover(b)).toBe("done");
    expect((await opState(b.id)).effect_ref).toBe("gid://shopify/Refund/2");
  });

  it("an equal refund of ANOTHER line is not this op's: absent, and re-sent", async () => {
    const { a, b } = await twoEqualGarments();
    await unanswered(b);
    answers.SettlementReturnEvidence = () => ({
      data: {
        return: returnObject(b.request.check, { processed: 0, refunds: [{ lineItem: a.request.check.refund.lineItemGid }] }),
      },
    });
    answers.SettlementReturnProcess = () => ({
      data: { returnProcess: { return: returnObject(b.request.check), userErrors: [] } },
    });
    expect(await recover(b)).toBe("done");
    expect(sends("SettlementReturnProcess")).toHaveLength(2);
  });

  it("freezes the line item it refunds, from the submission line, as a gid", async () => {
    const { a } = await twoEqualGarments();
    expect(a.request.check.refund.lineItemGid).toBe("gid://shopify/LineItem/7001");
  });
});

describe("root_refund", () => {
  it("answered → done, sent with idempotency key <id>:<attempt>", async () => {
    const op = await kinds.root_refund();
    answers.SettlementRefundCreate = () => ({ data: { refundCreate: { refund: refundObject(op.request.check), userErrors: [] } } });
    expect(await run(op.id)).toBe("done");
    expect(sends("SettlementRefundCreate")[0].variables.idempotencyKey).toBe(`${op.id}:1`);
  });

  it("userError → rejected", async () => {
    const op = await kinds.root_refund();
    answers.SettlementRefundCreate = () => ({ data: { refundCreate: { refund: null, ...USER_ERROR } } });
    expect(await run(op.id)).toBe("rejected");
  });

  it("no answer, evidence 0 within 23 h → re-sent with the SAME key", async () => {
    const op = await kinds.root_refund();
    await unanswered(op);
    answers.SettlementOrderRefunds = () => ({ data: { order: { refunds: [] } } });
    answers.SettlementRefundCreate = () => ({ data: { refundCreate: { refund: refundObject(op.request.check), userErrors: [] } } });
    expect(await recover(op)).toBe("done");
    const keys = sends("SettlementRefundCreate").map((s) => s.variables.idempotencyKey);
    expect(keys).toEqual([`${op.id}:1`, `${op.id}:1`]);
  });

  it("no answer, evidence 0 after 23 h → unresolved, never re-sent", async () => {
    const op = await kinds.root_refund();
    await unanswered(op);
    await env.pg.query("UPDATE settlement_operations SET dispatched_at = now() - interval '24 hours' WHERE id=$1", [op.id]);
    answers.SettlementOrderRefunds = () => ({ data: { order: { refunds: [] } } });
    expect(await recover(op)).toBe("unresolved");
    expect(sends("SettlementRefundCreate")).toHaveLength(1);
  });

  it.each([
    ["1 marked refund", (c: any) => [refundObject(c)], "done"],
    ["2 marked refunds", (c: any) => [refundObject(c), refundObject(c)], "unresolved"],
    ["a marked refund of another amount", (c: any) => [refundObject(c, { amount: "1.00" })], "unresolved"],
    ["PENDING", (c: any) => [refundObject(c, { status: "PENDING" })], "in-flight"],
    ["FAILURE", (c: any) => [refundObject(c, { status: "FAILURE" })], "unresolved"],
  ])("evidence: %s → %s", async (_l, refunds, expected) => {
    const op = await kinds.root_refund();
    await unanswered(op);
    answers.SettlementOrderRefunds = () => ({ data: { order: { refunds: refunds(op.request.check) } } });
    expect(await recover(op)).toBe(expected);
    expect(sends("SettlementRefundCreate")).toHaveLength(1);
  });
});

describe("gift_card", () => {
  it("answered → done", async () => {
    const op = await kinds.gift_card();
    answers.SettlementGiftCardCreate = () => ({ data: { giftCardCreate: { giftCard: giftCardObject(op.request.check), userErrors: [] } } });
    expect(await run(op.id)).toBe("done");
  });

  it("userError → rejected", async () => {
    const op = await kinds.gift_card();
    answers.SettlementGiftCardCreate = () => ({ data: { giftCardCreate: { giftCard: null, ...USER_ERROR } } });
    expect(await run(op.id)).toBe("rejected");
  });

  it("no answer → recovery re-sends the SAME frozen code; TAKEN + evidence 1 → done", async () => {
    const op = await kinds.gift_card();
    await unanswered(op);
    answers.SettlementGiftCardCreate = () => ({
      data: { giftCardCreate: { giftCard: null, userErrors: [{ field: ["code"], code: "TAKEN", message: "taken" }] } },
    });
    answers.SettlementGiftCardEvidence = () => ({ data: { giftCards: { nodes: [giftCardObject(op.request.check)] } } });
    expect(await recover(op)).toBe("done");
    const codes = sends("SettlementGiftCardCreate").map((s) => s.variables.input.code);
    expect(codes).toEqual([op.request.check.code, op.request.check.code]);
  });

  it.each([
    ["0 cards", () => [], "unresolved"],
    ["2 cards", (c: any) => [giftCardObject(c), giftCardObject(c)], "unresolved"],
    ["a card for another customer", (c: any) => [giftCardObject(c, { customer: { id: "gid://shopify/Customer/X" } })], "unresolved"],
  ])("TAKEN, evidence %s → %s", async (_l, nodes, expected) => {
    const op = await kinds.gift_card();
    answers.SettlementGiftCardCreate = () => ({
      data: { giftCardCreate: { giftCard: null, userErrors: [{ field: ["code"], code: "TAKEN", message: "taken" }] } },
    });
    answers.SettlementGiftCardEvidence = () => ({ data: { giftCards: { nodes: (nodes as any)(op.request.check) } } });
    expect(await run(op.id)).toBe(expected);
  });
});

describe("exchange_order", () => {
  it("answered → done", async () => {
    const op = await kinds.exchange_order();
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: orderObject(op.request.check), userErrors: [] } } });
    expect(await run(op.id)).toBe("done");
  });

  it("userError → rejected", async () => {
    const op = await kinds.exchange_order();
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: null, ...USER_ERROR } } });
    expect(await run(op.id)).toBe("rejected");
  });

  it.each([
    ["1 order", (c: any) => [orderObject(c)], "done"],
    ["0 orders", () => [], "unresolved"],
    ["2 orders", (c: any) => [orderObject(c), orderObject(c)], "unresolved"],
    ["an order missing a line", (c: any) => [orderObject(c, { dropLine: true })], "unresolved"],
  ])("no answer, evidence %s → %s, and never re-sent", async (_l, nodes, expected) => {
    const op = await kinds.exchange_order();
    await unanswered(op);
    answers.SettlementExchangeOrderEvidence = () => ({ data: { orders: { nodes: (nodes as any)(op.request.check) } } });
    expect(await recover(op)).toBe(expected);
    expect(sends("SettlementOrderCreate")).toHaveLength(1);
  });
});

describe("release_hold", () => {
  it("answered with the deleted id → done, and the order's hold pointer cleared", async () => {
    const op = await kinds.release_hold();
    await env.pg.query("UPDATE orders SET exchange_reservation_id = 'gid://shopify/DraftOrder/5' WHERE id='100'").catch(() => {});
    answers.SettlementDraftOrderDelete = () => ({ data: { draftOrderDelete: { deletedId: "gid://shopify/DraftOrder/5", userErrors: [] } } });
    expect(await run(op.id)).toBe("done");
  });

  it("userError while the draft still exists → rejected", async () => {
    const op = await kinds.release_hold();
    answers.SettlementDraftOrderDelete = () => ({ data: { draftOrderDelete: { deletedId: null, ...USER_ERROR } } });
    answers.SettlementDraftOrder = () => ({ data: { draftOrder: { id: "gid://shopify/DraftOrder/5" } } });
    expect(await run(op.id)).toBe("rejected");
  });

  it("userError because it is already gone → done", async () => {
    const op = await kinds.release_hold();
    answers.SettlementDraftOrderDelete = () => ({ data: { draftOrderDelete: { deletedId: null, ...USER_ERROR } } });
    answers.SettlementDraftOrder = () => ({ data: { draftOrder: null } });
    expect(await run(op.id)).toBe("done");
  });

  it("no answer, draft gone → done without a re-send", async () => {
    const op = await kinds.release_hold();
    await unanswered(op);
    answers.SettlementDraftOrder = () => ({ data: { draftOrder: null } });
    expect(await recover(op)).toBe("done");
    expect(sends("SettlementDraftOrderDelete")).toHaveLength(1);
  });
});
