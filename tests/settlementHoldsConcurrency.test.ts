import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sys, vsub } from "./support/verified";
import { pg16Available, startPg16 } from "./support/pg16";
import { insertFrozenReleaseHold, planFor, seedSubmission } from "./support/settlementSeed";
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

  // A blocking hold refuses the customer's cancellation under its own lock
  // (operator-hold review P1), so in every order the operator owns it.
  it("(5) --take vs the customer's cancellation, in both orders: the hold wins, never a cancellation refund", async () => {
    const { claimForCancellation } = await import("@/lib/server/submissionScope");
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const { seeded, holdId } = await heldSubmission();
      const cancel = () => claimForCancellation(vsub(seeded.orderId, seeded.id));
      const take = () => resolve(holdId, "take");
      // Take first, cancel first, and both at once on two connections.
      const mode = i % 3;
      const [taken, cancelled] =
        mode === 0
          ? await (async () => { const t = await take(); return [t, await cancel()] as const; })()
          : mode === 1
            ? await (async () => { const c = await cancel(); return [await take(), c] as const; })()
            : await Promise.all([take(), cancel()]);
      expect(taken.ok).toBe(true);
      expect(cancelled).toBe("held");
      const [s] = await q("SELECT holder FROM return_submissions WHERE id=$1", [seeded.id]);
      expect(s.holder).toBe("manual");
    }
  });

  // ── Review #2/#7: a hold committed after a claim revokes that claim's send ──

  /** An admitted submission whose exchange is done, and a refund sibling claimed by worker A. */
  async function claimedSibling() {
    const seeded = await seedSubmission(env.pool as any, { lines: exchangeLines() });
    const plan = planFor(seeded);
    const { insertAdmission, claim } = await ledger();
    await insertAdmission(sys, { submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: plan.reverseFulfillment });
    const exchange = plan.ops.find((o) => o.kind === "exchange_order")!;
    const sibling = plan.ops.find((o) => o.kind === "process_refund")!;
    await q("UPDATE settlement_operations SET state='done' WHERE id=$1", [exchange.id]);
    const me = randomUUID();
    const claimed = (await claim(sys, sibling.id, me))!;
    expect(claimed).not.toBeNull();
    return { seeded, exchange, sibling, me, claimed };
  }
  const seqOf = async (id: string) => Number((await q("SELECT admission_seq FROM return_submissions WHERE id=$1", [id]))[0].admission_seq);
  const stateOf = async (id: string) => (await q("SELECT state FROM settlement_operations WHERE id=$1", [id]))[0].state;

  it("(6) claim → A3 hold (another worker meets a historical release_hold) → dispatch: no send", async () => {
    const { seeded, exchange, sibling, me, claimed } = await claimedSibling();
    const { claim, dispatch } = await ledger();
    const legacy = await insertFrozenReleaseHold(env.pool as any, {
      submissionId: seeded.id, orderId: seeded.orderId, after: exchange.id, draftOrderId: "gid://shopify/DraftOrder/5",
    });
    expect(await claim(sys, legacy.id, randomUUID())).toBeNull();
    expect(await q("SELECT cause FROM settlement_holds")).toEqual([{ cause: "legacy-plan" }]);
    expect(await dispatch(sys, claimed, me)).toBeNull();
    expect(await stateOf(sibling.id)).toBe("claimed");
  });

  it("(7) claim → stock-short hold → dispatch: no send", async () => {
    const { seeded, sibling, me, claimed } = await claimedSibling();
    const { insertHold, dispatch } = await ledger();
    expect((await insertHold(sys, { submissionId: seeded.id, seenSeq: await seqOf(seeded.id), short: SHORT })).held).toBe(true);
    expect(await dispatch(sys, claimed, me)).toBeNull();
    expect(await stateOf(sibling.id)).toBe("claimed");
  });

  it("(8) a hold writer holding the submission lock: dispatch waits for it and then sees its hold", async () => {
    const { seeded, sibling, me, claimed } = await claimedSibling();
    const { dispatch } = await ledger();
    // A hold writer's transaction, paused after its admission_seq bump (the
    // lock every hold writer takes) and its hold row, not yet committed.
    const writer = await env.pool.connect();
    try {
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await writer.query("UPDATE return_submissions SET admission_seq = admission_seq + 1 WHERE id=$1", [seeded.id]);
      await writer.query(
        `INSERT INTO settlement_holds (id, submission_id, cause, detail) VALUES ($1, $2, 'stock-short', '{}'::jsonb)`,
        [randomUUID(), seeded.id]
      );
      let settled = false;
      const pending = dispatch(sys, claimed, me).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the submission row lock
      await writer.query("COMMIT");
      expect(await pending).toBeNull();
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined); // never return a connection mid-transaction
      writer.release();
    }
    expect(await stateOf(sibling.id)).toBe("claimed");
  });

  it("(9) the same lock held without a hold (rolled back): dispatch waits, then sends", async () => {
    const { seeded, sibling, me, claimed } = await claimedSibling();
    const { dispatch } = await ledger();
    const writer = await env.pool.connect();
    try {
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await writer.query("UPDATE return_submissions SET admission_seq = admission_seq + 1 WHERE id=$1", [seeded.id]);
      const pending = dispatch(sys, claimed, me);
      await new Promise((r) => setTimeout(r, 300));
      await writer.query("ROLLBACK");
      expect(await pending).not.toBeNull();
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined); // never return a connection mid-transaction
      writer.release();
    }
    expect(await stateOf(sibling.id)).toBe("dispatched");
  });

  it("(10) dispatch vs two hold writers at once: no deadlock, and the op is what dispatch answered", async () => {
    const { claim, dispatch, insertHold } = await ledger();
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const { seeded, exchange, sibling, me, claimed } = await claimedSibling();
      const legacy = await insertFrozenReleaseHold(env.pool as any, {
        submissionId: seeded.id, orderId: seeded.orderId, after: exchange.id, draftOrderId: "gid://shopify/DraftOrder/5",
      });
      const seq = await seqOf(seeded.id);
      // Serialized on the submission row: no deadlock, no error, and the op's
      // state is exactly what dispatch answered. (Which order won is (6)–(9).)
      const [token] = await Promise.all([
        dispatch(sys, claimed, me),
        insertHold(sys, { submissionId: seeded.id, seenSeq: seq, short: SHORT }),
        claim(sys, legacy.id, randomUUID()),
      ]);
      const holds = await q("SELECT id FROM settlement_holds");
      expect(holds.length).toBeGreaterThanOrEqual(1);
      expect(await stateOf(sibling.id)).toBe(token ? "dispatched" : "claimed");
    }
  });

  it("(11) --take vs (release → claim → dispatch): never a send on a submission held by hand", async () => {
    for (let i = 0; i < ROUNDS; i += 1) {
      await env.reset();
      const seeded = await seedSubmission(env.pool as any, { lines: exchangeLines() });
      const plan = planFor(seeded);
      const { insertAdmission, insertHold, claim, dispatch } = await ledger();
      await insertAdmission(sys, { submissionId: seeded.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: plan.reverseFulfillment });
      const exchange = plan.ops.find((o) => o.kind === "exchange_order")!;
      const sibling = plan.ops.find((o) => o.kind === "process_refund")!;
      await q("UPDATE settlement_operations SET state='done' WHERE id=$1", [exchange.id]);
      const { holdId } = await insertHold(sys, { submissionId: seeded.id, seenSeq: await seqOf(seeded.id), short: SHORT });
      const worker = async () => {
        const released = await resolve(holdId, "release");
        if (!released.ok) return null;
        const me = randomUUID();
        const claimed = await claim(sys, sibling.id, me);
        return claimed ? dispatch(sys, claimed, me) : null;
      };
      const [token, taken] = await Promise.all([worker(), resolve(holdId, "take")]);
      const [s] = await q("SELECT holder FROM return_submissions WHERE id=$1", [seeded.id]);
      const sent = await q("SELECT id FROM settlement_operations WHERE state='dispatched'");
      if (taken.ok) {
        expect(s.holder).toBe("manual");
        expect(token).toBeNull();
        expect(sent).toHaveLength(0);
      }
      expect(Boolean(token) && s.holder === "manual").toBe(false);
    }
  });
});
