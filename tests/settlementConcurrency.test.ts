import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pg16Available, startPg16 } from "./support/pg16";
import { planFor, seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";
import { giftCardObject, orderObject, returnObject } from "./support/shopifyEvidence";

// Races between CONNECTIONS, on a real local PostgreSQL 16 (PGlite has one
// connection, so it cannot race). Each concurrent call below takes its own
// pooled connection; `transact` is BEGIN READ COMMITTED … COMMIT on one, which
// is what neon's non-interactive sql.transaction runs server-side.
//
// Not exercised here: the neon-http adapter itself (it needs Neon's HTTP
// endpoint). What is exercised is the SQL it sends.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
let env: Awaited<ReturnType<typeof startPg16>>;
vi.mock("@/db/drizzle", () => ({
  get default() {
    return env.db;
  },
  transact: (s: any) => env.transact(s),
}));

const sent: string[] = [];
const answers: Record<string, (v: any) => any> = {};
vi.mock("@/lib/settlement/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settlement/shopify")>();
  return {
    ...actual,
    shopifyGraphQL: async (query: string, variables: any) => {
      const name = /(?:query|mutation) (\w+)/.exec(query)![1];
      sent.push(name);
      await new Promise((r) => setTimeout(r, 20));
      const answer = answers[name];
      return answer ? { kind: "answer", body: answer(variables) } : { kind: "no-answer", error: "timeout" };
    },
  };
});

const ledger = () => import("@/lib/settlement/ledger");
const q = async (sql: string, params: any[] = []) => (await env.pool.query(sql, params)).rows;
const ROUNDS = 15;

describe.skipIf(!pg16Available)("settlement races on PostgreSQL 16", () => {
  beforeAll(async () => {
    env = await startPg16();
  }, 60_000);
  afterAll(async () => {
    await env?.stop();
  });
  beforeEach(async () => {
    await env.reset();
    sent.length = 0;
    for (const k of Object.keys(answers)) delete answers[k];
  });

  it("two racing admissions: exactly one admits, every effect written once", async () => {
    const { insertAdmission } = await ledger();
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const seeded = await seedSubmission(env.pool as any, { lines: [line(1), line(2)] });
      const a = planFor(seeded);
      const b = planFor(seeded);
      const results = await Promise.all([
        insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: a.ops, reverseFulfillment: a.reverseFulfillment }),
        insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: b.ops, reverseFulfillment: b.reverseFulfillment }),
      ]);
      expect(results.filter((r) => r.admitted)).toHaveLength(1);
      expect(await q("SELECT scope_key FROM settlement_operations ORDER BY scope_key")).toHaveLength(2);
    }
  });

  it("admission against cancellation: exactly one holder, and ops exist only if settlement won", async () => {
    const { insertAdmission } = await ledger();
    const { claimForCancellation } = await import("@/lib/submissionCancellation");
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const seeded = await seedSubmission(env.pool as any);
      const plan = planFor(seeded);
      const [admitted, cancelled] = await Promise.all([
        insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] }),
        claimForCancellation(seeded.id),
      ]);
      expect(admitted.admitted !== cancelled).toBe(true);
      const [s] = await q("SELECT holder FROM return_submissions WHERE id=$1", [seeded.id]);
      expect(s.holder).toBe(admitted.admitted ? "settlement" : "cancellation");
      expect(await q("SELECT id FROM settlement_operations")).toHaveLength(admitted.admitted ? 1 : 0);
    }
  });

  it("racing claims and an expired lease: one owner at a time, the loser's record fenced off", async () => {
    const { insertAdmission, claim, dispatch, recordDone } = await ledger();
    const seeded = await seedSubmission(env.pool as any);
    const plan = planFor(seeded);
    await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] });
    const id = plan.ops[0].id;
    const claims = await Promise.all(Array.from({ length: 8 }, () => claim(id, randomUUID())));
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);

    const old = winners[0]!;
    await env.pool.query("UPDATE settlement_operations SET lease_until = now() - interval '1 second'");
    const [taken] = await Promise.all([claim(id, randomUUID()), dispatch(old, old.owner!)]);
    // The expired holder can no longer dispatch, and anything it records is refused.
    expect(taken).not.toBeNull();
    const fenced = await recordDone(old, { state: "dispatched", owner: old.owner, attempt: old.attempt }, "x", {});
    expect(fenced.done).toBe(false);
  });

  it("two ops of one line done together: the line settles exactly once", async () => {
    const { insertAdmission, claim, dispatch, recordDone } = await ledger();
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const seeded = await seedSubmission(env.pool as any, { tender: "credit" });
      const plan = planFor(seeded);
      await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] });
      const tokens = [];
      for (const op of plan.ops) {
        const me = randomUUID();
        tokens.push((await dispatch((await claim(op.id, me))!, me))!);
      }
      const results = await Promise.all(
        tokens.map((t) => recordDone(t, { state: "dispatched", owner: t.owner, attempt: t.attempt }, "ref", {}))
      );
      expect(results.every((r) => r.done)).toBe(true);
      // Neither missed the line, and only one of them stamped it.
      expect(results.flatMap((r) => r.settled)).toEqual([1]);
      expect((await q("SELECT refunded FROM productsorder WHERE id=1"))[0].refunded).toBe(true);
    }
  });

  it("an exchange order is sent once, however many runners race for it", async () => {
    const { insertAdmission } = await ledger();
    const { run } = await import("@/lib/settlement/run");
    const seeded = await seedSubmission(env.pool as any, {
      lines: [line(1, { action: "CAMBIO", newVariantId: "gid://shopify/ProductVariant/11", payCents: 0 })],
    });
    const plan = planFor(seeded);
    await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] });
    const op = plan.ops.find((o) => o.kind === "exchange_order")! as any;
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: orderObject(op.request.check), userErrors: [] } } });
    const results = await Promise.all(Array.from({ length: 6 }, () => run(op.id)));
    expect(results.filter((r) => r === "done")).toHaveLength(1);
    expect(sent.filter((n) => n === "SettlementOrderCreate")).toHaveLength(1);
  });

  it("goods and card for one line, run by racing runners, pay the card once", async () => {
    const { insertAdmission } = await ledger();
    const { run } = await import("@/lib/settlement/run");
    const seeded = await seedSubmission(env.pool as any, { tender: "credit" });
    const plan = planFor(seeded);
    await insertAdmission({ submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: [] });
    const goods = plan.ops.find((o) => o.kind === "process_goods")! as any;
    const card = plan.ops.find((o) => o.kind === "gift_card")! as any;
    answers.SettlementReturnProcess = () => ({ data: { returnProcess: { return: returnObject(goods.request.check), userErrors: [] } } });
    answers.SettlementGiftCardCreate = () => ({ data: { giftCardCreate: { giftCard: giftCardObject(card.request.check), userErrors: [] } } });
    await Promise.all([run(goods.id), run(card.id), run(card.id), run(goods.id), run(card.id)]);
    expect(sent.filter((n) => n === "SettlementGiftCardCreate")).toHaveLength(1);
    expect(sent.filter((n) => n === "SettlementReturnProcess")).toHaveLength(1);
    expect((await q("SELECT refunded FROM productsorder WHERE id=1"))[0].refunded).toBe(true);
  });
});
