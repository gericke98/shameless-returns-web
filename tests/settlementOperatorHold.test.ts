import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sys, vsub } from "./support/verified";
import { settlementDatabase } from "./support/settlementDb";
import { planFor, seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";
import type { SubmissionLineRow } from "@/lib/settlement/ledger";
import { configureShopify } from "./support/serviceEnv";

// Settlement refuses before the claim without Shopify keys (F2a).
configureShopify();

// resolve-hold --open: an operator holds an accepted submission BEFORE
// settlement would settle it — the customer was paid by hand outside the
// ledger (#313127: refunded in Shopify, replacement back in stock). After it
// nothing automated plans or sends anything; --take / --done finish it.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
const env = settlementDatabase();
vi.mock("@/db/drizzle", async () => (await import("./support/drizzleMock")).drizzleModule(await (() => ({ default: env.db, transact: (s: any) => env.transact(s), readQuery: (s: any) => env.readQuery(s) }))()));

const sent: Array<{ name: string; variables: any }> = [];
vi.mock("@/lib/settlement/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settlement/shopify")>();
  return {
    ...actual,
    shopifyGraphQL: async (query: string, variables: any) => {
      sent.push({ name: /(?:query|mutation) (\w+)/.exec(query)![1], variables });
      return { kind: "no-answer", error: "timeout" };
    },
  };
});
vi.mock("@/lib/server/opsAlertOutbox", () => ({ enqueueOpsAlerts: async () => ({ failed: 0 }) }));
const stock = vi.hoisted(() => ({ available: {} as Record<string, number>, reason: null as string | null, reads: 0 }));
vi.mock("@/lib/server/amphoraStock", async () => (await import("./support/amphoraStockMock")).amphoraStockModule(stock));

const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;
const admit = async (id: string, lines: number[]) => (await import("@/lib/settlement/admission")).admit(sys, id, lines);
const open = async (id: string, over: { by?: string; evidence?: string; write?: boolean } = {}) =>
  (await import("@/lib/settlement/holdResolution")).openHold(
    sys,
    id,
    { by: over.by ?? "santi", evidence: over.evidence ?? "refunded 40,55 by hand in Shopify" },
    { write: over.write ?? true }
  );
const resolve = async (holdId: string, verb: "take" | "done" | "release", evidence = "checked") =>
  (await import("@/lib/settlement/holdResolution")).resolveHold(sys, holdId, { verb, by: "santi", evidence }, { write: true });

const V = "gid://shopify/ProductVariant/11";
const exchangeLine = (po = 1, over: Partial<SubmissionLineRow> = {}) =>
  line(po, { action: "CAMBIO", newVariantId: V, payCents: 0, ...over });
const holds = (id: string) => q(`SELECT id, cause, detail, taken_by, resolution FROM settlement_holds WHERE submission_id=$1`, [id]);
const seqOf = async (id: string) => Number((await q(`SELECT admission_seq FROM return_submissions WHERE id=$1`, [id]))[0].admission_seq);
const opsOf = (id: string) => q(`SELECT id, kind, state FROM settlement_operations WHERE submission_id=$1`, [id]);

beforeAll(async () => {
  await env.ready;
});
beforeEach(async () => {
  await env.reset();
  sent.length = 0;
  (await import("./support/amphoraStockMock")).resetStock(stock);
});

describe("resolve-hold --open", () => {
  it("paid by hand, replacement back in stock: open → nothing admitted or sent; take → done marks the rows", async () => {
    const s = await seedSubmission(env.pg, { lines: [exchangeLine(1)] });
    stock.available[V] = 45;

    expect(await open(s.id, { write: false })).toMatchObject({ ok: true, written: false });
    expect(await holds(s.id)).toHaveLength(0);

    const opened = await open(s.id);
    expect(opened).toMatchObject({ ok: true, written: true });
    const [hold] = await holds(s.id);
    expect(hold).toMatchObject({ cause: "operator", detail: { openedBy: "santi", why: "refunded 40,55 by hand in Shopify" } });
    expect(await seqOf(s.id)).toBe(1);
    const [alert] = await q(`SELECT subject, body FROM ops_alerts WHERE dedupe_key=$1`, [`settlement-held:${hold.id}`]);
    expect(alert.subject).toMatch(/SETTLEMENT HELD — operator/);
    expect(alert.body).toMatch(/refunded 40,55 by hand/);

    // Stock is there, so without the hold admission would plan the exchange.
    expect(await admit(s.id, [1])).toEqual({ ok: false, held: `operator:${hold.id}` });
    expect(await opsOf(s.id)).toHaveLength(0);
    expect(sent).toHaveLength(0);

    expect(await resolve(hold.id, "take")).toMatchObject({ ok: true, written: true });
    expect(await resolve(hold.id, "done", "refund 40,55 in Shopify 26 Nov; customer orders M himself")).toMatchObject({ ok: true });
    expect((await q(`SELECT refunded FROM productsorder`)).map((r) => r.refunded)).toEqual([true]);
    expect(await admit(s.id, [1])).toEqual({ ok: false, held: `resolved-by-hand:${hold.id}` });
    expect(sent).toHaveLength(0);
  });

  it("an admitted submission: its planned ops are never claimed while held, and --take voids them", async () => {
    const s = await seedSubmission(env.pg, { lines: [exchangeLine(1), line(2)] });
    const plan = planFor(s);
    const { insertAdmission } = await import("@/lib/settlement/ledger");
    await insertAdmission(sys, { submissionId: s.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: plan.reverseFulfillment });
    stock.available[V] = 45;

    expect(await open(s.id)).toMatchObject({ ok: true, written: true });
    const { run } = await import("@/lib/settlement/run");
    for (const op of await opsOf(s.id)) await run(sys, op.id);
    expect(sent.filter((x) => /orderCreate|returnProcess|refundCreate|returnRefund|giftCardCreate/i.test(x.name))).toHaveLength(0);
    expect((await opsOf(s.id)).every((o) => o.state === "pending")).toBe(true);

    const [hold] = await holds(s.id);
    expect(await resolve(hold.id, "take")).toMatchObject({ ok: true });
    expect((await opsOf(s.id)).every((o) => o.state === "void")).toBe(true);
  });

  it("refuses: no evidence, no who, a second open, an op in flight, a non-accepted or taken submission", async () => {
    const s = await seedSubmission(env.pg, { lines: [exchangeLine(1)] });
    expect(await open(s.id, { evidence: " " })).toMatchObject({ ok: false, reason: expect.stringMatching(/--evidence/) });
    expect(await open(s.id, { by: "" })).toMatchObject({ ok: false, reason: expect.stringMatching(/--by/) });
    expect(await open("00000000-0000-0000-0000-000000000000")).toMatchObject({ ok: false, reason: expect.stringMatching(/no submission/) });

    expect(await open(s.id)).toMatchObject({ ok: true });
    expect(await open(s.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/already blocks/) });
    expect(await holds(s.id)).toHaveLength(1);

    const t = await seedSubmission(env.pg, { orderId: "200", lines: [exchangeLine(3)] });
    await q(`UPDATE return_submissions SET holder='settlement' WHERE id=$1`, [t.id]);
    await q(
      `INSERT INTO settlement_operations (id, submission_id, kind, scope_key, request, state, attempt, dispatched_at)
       VALUES (gen_random_uuid(), $1, 'process_refund', 'money:t', '{}'::jsonb, 'dispatched', 1, now())`,
      [t.id]
    );
    expect(await open(t.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/in flight/) });

    await q(`UPDATE return_submissions SET holder='cancellation', state='cancelled' WHERE id=$1`, [t.id]);
    expect(await open(t.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/cancelled, not accepted/) });
    await q(`UPDATE return_submissions SET state='accepted', holder='manual' WHERE id=$1`, [t.id]);
    expect(await open(t.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/held by manual/) });
  });

  it("a customer cannot cancel a held submission (no refund), before or after --take", async () => {
    const s = await seedSubmission(env.pg, { lines: [exchangeLine(1)] });
    expect(await open(s.id)).toMatchObject({ ok: true });
    const { claimForCancellation } = await import("@/lib/server/submissionScope");
    expect(await claimForCancellation(vsub(s.orderId, s.id))).toBe("held");
    expect((await q(`SELECT holder FROM return_submissions WHERE id=$1`, [s.id]))[0].holder).toBeNull();

    const [hold] = await holds(s.id);
    expect(await resolve(hold.id, "take")).toMatchObject({ ok: true });
    expect(await claimForCancellation(vsub(s.orderId, s.id))).toBe("held");
    expect(await resolve(hold.id, "done", "refunded by hand")).toMatchObject({ ok: true });
    expect(await claimForCancellation(vsub(s.orderId, s.id))).toBe("held");
    expect((await q(`SELECT holder FROM return_submissions WHERE id=$1`, [s.id]))[0].holder).toBe("manual");
  });

  it("the write re-checks: an operation that went in flight after the read is not held over", async () => {
    const s = await seedSubmission(env.pg, { lines: [exchangeLine(1)] });
    await q(`UPDATE return_submissions SET holder='settlement' WHERE id=$1`, [s.id]);
    const real = env.readQuery;
    let done = false;
    (env as any).readQuery = async (stmt: any) => {
      const out = await real(stmt);
      if (!done) {
        done = true;
        await q(
          `INSERT INTO settlement_operations (id, submission_id, kind, scope_key, request, state, attempt, dispatched_at)
           VALUES (gen_random_uuid(), $1, 'process_refund', 'money:race', '{}'::jsonb, 'dispatched', 1, now())`,
          [s.id]
        );
      }
      return out;
    };
    try {
      expect(await open(s.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/changed meanwhile/) });
    } finally {
      (env as any).readQuery = real;
    }
    expect(await holds(s.id)).toHaveLength(0);
  });

  it("the write re-checks: a submission that moved after the read is not held", async () => {
    const s = await seedSubmission(env.pg, { lines: [exchangeLine(1)] });
    const real = env.readQuery;
    let bumped = false;
    // Bump the fence between openHold's read and its write (a racing admission).
    (env as any).readQuery = async (stmt: any) => {
      const out = await real(stmt);
      if (!bumped) {
        bumped = true;
        await q(`UPDATE return_submissions SET admission_seq = admission_seq + 1 WHERE id=$1`, [s.id]);
      }
      return out;
    };
    try {
      expect(await open(s.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/changed meanwhile/) });
    } finally {
      (env as any).readQuery = real;
    }
    expect(await holds(s.id)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM ops_alerts`)).toHaveLength(0);
  });
});
