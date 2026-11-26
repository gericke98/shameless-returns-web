import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sys, vsub } from "./support/verified";
import { pg16Available, startPg16 } from "./support/pg16";
import { planFor, seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";

// FX holds raced between CONNECTIONS on a real PostgreSQL 16 (the pattern of
// tests/settlementConcurrency.test.ts): every hold mutation is one statement
// on the submission's admission fence, so the losers write nothing.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
let env: Awaited<ReturnType<typeof startPg16>>;
vi.mock("@/db/drizzle", async () => (await import("./support/drizzleMock")).drizzleModule(await (() => ({
  get default() {
    return env.db;
  },
  transact: (s: any) => env.transact(s),
  readQuery: (s: any) => env.readQuery(s),
}))()));
vi.mock("@/lib/settlement/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settlement/shopify")>();
  return { ...actual, shopifyGraphQL: async () => ({ kind: "no-answer", error: "timeout" }) };
});
const stock = vi.hoisted(() => ({ available: {} as Record<string, number>, reason: null as string | null, reads: 0 }));
vi.mock("@/lib/server/amphoraStock", async () => (await import("./support/amphoraStockMock")).amphoraStockModule(stock));

const ledger = () => import("@/lib/settlement/ledger");
const q = async (sql: string, params: any[] = []) => (await env.pool.query(sql, params)).rows;
const ROUNDS = 15;
const V = "gid://shopify/ProductVariant/11";
const SHORT = [{ sku: V, need: 1, available: 0, earlier: 0 }];
const exchangeLines = () => [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 }), line(2)];

async function heldSubmission() {
  const seeded = await seedSubmission(env.pool as any, { lines: exchangeLines() });
  const { insertHold } = await ledger();
  const { holdId } = await insertHold(sys, { submissionId: seeded.id, seenSeq: 0, short: SHORT });
  return { seeded, holdId };
}
const resolve = async (holdId: string, verb: "take" | "release") =>
  (await import("@/lib/settlement/holdResolution")).resolveHold(
    sys,
    holdId,
    { verb, by: "santi", evidence: "raced" },
    { write: true }
  );

describe.skipIf(!pg16Available)("FX hold races on PostgreSQL 16", () => {
  beforeAll(async () => {
    env = await startPg16();
  }, 60_000);
  afterAll(async () => {
    await env?.stop();
  });
  beforeEach(async () => {
    await env.reset();
  });

  it("(1) insertHold vs insertAdmission on the same seen sequence: exactly one", async () => {
    const { insertAdmission, insertHold } = await ledger();
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const seeded = await seedSubmission(env.pool as any, { lines: exchangeLines() });
      const plan = planFor(seeded);
      const [admitted, held] = await Promise.all([
        insertAdmission(sys, { submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: plan.reverseFulfillment }),
        insertHold(sys, { submissionId: seeded.id, seenSeq: 0, short: SHORT }),
      ]);
      expect(admitted.admitted !== held.held).toBe(true);
      const ops = await q("SELECT id FROM settlement_operations");
      const holds = await q("SELECT id FROM settlement_holds");
      const alerts = await q("SELECT dedupe_key FROM ops_alerts");
      expect(ops.length > 0).toBe(admitted.admitted);
      expect(holds).toHaveLength(held.held ? 1 : 0);
      expect(alerts).toHaveLength(held.held ? 1 : 0);
    }
  });

  it("(2) --take vs insertAdmission: never both", async () => {
    const { insertAdmission } = await ledger();
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const { seeded, holdId } = await heldSubmission();
      const plan = planFor(seeded);
      const [admitted, taken] = await Promise.all([
        insertAdmission(sys, { submissionId: seeded.id, seenSeq: 1, ops: plan.ops, reverseFulfillment: plan.reverseFulfillment }),
        resolve(holdId, "take"),
      ]);
      expect(admitted.admitted && taken.ok).toBe(false);
      const [s] = await q("SELECT holder FROM return_submissions WHERE id=$1", [seeded.id]);
      if (taken.ok) expect(s.holder).toBe("manual");
      const live = await q("SELECT id FROM settlement_operations WHERE state NOT IN ('void', 'done')");
      expect(live).toHaveLength(0);
    }
  });

  it("(3) two resolutions of one hold (--take vs --release): exactly one", async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const { holdId } = await heldSubmission();
      const order = i % 2 === 0 ? (["take", "release"] as const) : (["release", "take"] as const);
      const results = await Promise.all(order.map((verb) => resolve(holdId, verb)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const [hold] = await q("SELECT taken_at, resolution FROM settlement_holds WHERE id=$1", [holdId]);
      // Never a hold that is both taken and released.
      expect(hold.taken_at !== null && hold.resolution === "release").toBe(false);
    }
  });

  it("(4) recordRejected(exchange) vs claims: the rejected exchange and its dependents are never claimed", async () => {
    const { insertAdmission, claim, dispatch, recordRejected } = await ledger();
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const seeded = await seedSubmission(env.pool as any, { lines: exchangeLines() });
      const plan = planFor(seeded);
      await insertAdmission(sys, { submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: plan.reverseFulfillment });
      const exchange = plan.ops.find((o) => o.kind === "exchange_order")!;
      const dependent = plan.ops.find((o) => o.kind !== "exchange_order")!;
      const me = randomUUID();
      const claimed = (await claim(sys, exchange.id, me))!;
      const token = (await dispatch(sys, claimed, me))!;
      const fence = { state: "dispatched" as const, owner: token.owner, leaseGen: token.leaseGen };
      const results = await Promise.all([
        recordRejected(sys, token as any, fence, "Insufficient inventory"),
        ...Array.from({ length: 4 }, () => claim(sys, exchange.id, randomUUID())),
        ...Array.from({ length: 4 }, () => claim(sys, dependent.id, randomUUID())),
      ]);
      expect(results[0]).toBe(true);
      expect(results.slice(1).filter(Boolean)).toHaveLength(0);
      // And afterwards, with the hold in place, still never.
      expect(await claim(sys, exchange.id, randomUUID())).toBeNull();
      expect(await q("SELECT cause FROM settlement_holds")).toEqual([{ cause: "exchange-rejected" }]);
    }
  });

  it("(5) --take vs the customer's cancellation, in both orders: exactly one owner", async () => {
    const { claimForCancellation } = await import("@/lib/server/submissionScope");
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const { seeded, holdId } = await heldSubmission();
      const cancel = () => claimForCancellation(vsub(seeded.orderId, seeded.id));
      const take = () => resolve(holdId, "take");
      const [taken, cancelled] =
        i % 2 === 0
          ? await Promise.all([take(), cancel()])
          : await Promise.all([cancel(), take()]).then(([c, t]) => [t, c] as const);
      expect(taken.ok !== (cancelled === "claimed")).toBe(true);
      const [s] = await q("SELECT holder FROM return_submissions WHERE id=$1", [seeded.id]);
      expect(s.holder).toBe(taken.ok ? "manual" : "cancellation");
      if (taken.ok) expect(cancelled).toBe("settled");
    }
  });
});
