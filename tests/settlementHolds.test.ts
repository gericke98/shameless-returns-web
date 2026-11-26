import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sys, vsub } from "./support/verified";
import { settlementDatabase } from "./support/settlementDb";
import { planFor, seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";
import { orderObject } from "./support/shopifyEvidence";
import type { SubmissionLineRow } from "@/lib/settlement/ledger";

// FX: Amphora authorizes the replacement (§#4 (d), A1), holds stop a
// submission on the admission fence (§#7), a rejected exchange is held, not
// re-sent (§#4), old shapes are refused (A3), and an operator takes a hold
// before settling it by hand (A2). Real ledger SQL in PGlite; Shopify mocked at
// the transport, Amphora at the stock reader's module boundary.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
const env = settlementDatabase();
vi.mock("@/db/drizzle", async () => (await import("./support/drizzleMock")).drizzleModule(await (() => ({ default: env.db, transact: (s: any) => env.transact(s), readQuery: (s: any) => env.readQuery(s) }))()));

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
const digest = vi.hoisted(() => [] as Array<{ dedupeKey: string; subject: string; body: string }>);
vi.mock("@/lib/server/opsAlertOutbox", () => ({
  enqueueOpsAlerts: async (alerts: any[]) => {
    digest.push(...alerts);
    return { failed: 0 };
  },
}));
const stock = vi.hoisted(() => ({ available: {} as Record<string, number>, reason: null as string | null, reads: 0 }));
vi.mock("@/lib/server/amphoraStock", async () => (await import("./support/amphoraStockMock")).amphoraStockModule(stock));

const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;
const ledger = () => import("@/lib/settlement/ledger");
const run = async (id: string) => (await import("@/lib/settlement/run")).run(sys, id);
const admit = async (id: string, lines: number[]) => (await import("@/lib/settlement/admission")).admit(sys, id, lines);
const resolve = async (holdId: string, verb: "take" | "done" | "release", over: { by?: string; evidence?: string } = {}) =>
  (await import("@/lib/settlement/holdResolution")).resolveHold(
    sys,
    holdId,
    { verb, by: over.by ?? "santi", evidence: over.evidence ?? "checked" },
    { write: true }
  );

const V = "gid://shopify/ProductVariant/11";
const exchangeLine = (po = 1, over: Partial<SubmissionLineRow> = {}) =>
  line(po, { action: "CAMBIO", newVariantId: V, payCents: 0, ...over });

/** What Shopify says about the return the seeded rows sit on (OPEN, unprocessed). */
function shopifyReturn(lines: SubmissionLineRow[], orderId = "100") {
  answers.SettlementAdmissionReturn = () => ({
    data: {
      return: {
        id: "gid://shopify/Return/1",
        status: "OPEN",
        exchangeLineItems: { nodes: [] },
        returnLineItems: {
          pageInfo: { hasNextPage: false },
          nodes: lines.map((l) => ({
            id: l.returnLineItemId,
            quantity: l.quantity,
            processedQuantity: 0,
            fulfillmentLineItem: { id: l.fulfillmentLineItemId },
          })),
        },
        reverseFulfillmentOrders: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              lineItems: {
                pageInfo: { hasNextPage: false },
                nodes: lines.map((l) => ({
                  id: `gid://shopify/ReverseFulfillmentOrderLineItem/${l.productsorderId}`,
                  totalQuantity: l.quantity,
                  fulfillmentLineItem: { id: l.fulfillmentLineItemId },
                })),
              },
            },
          ],
        },
        order: { id: `gid://shopify/Order/${orderId}`, customer: { id: "gid://shopify/Customer/9" }, totalPriceSet: null },
      },
    },
  });
}

/** An accepted submission of order `orderId` with an exchange (and a refund sibling), ready to admit. */
async function seeded(opts: { orderId?: string; lines?: SubmissionLineRow[] } = {}) {
  const lines = opts.lines ?? [exchangeLine(1), line(2)];
  const s = await seedSubmission(env.pg, { orderId: opts.orderId, lines });
  await q(
    `UPDATE orders SET shipping_name='Ana', shipping_address1='Calle 1', shipping_zip='28001', shipping_city='Madrid',
       shipping_province='Madrid', shipping_country='Spain', shipping_phone='600000000', email='c@example.com'
     WHERE id=$1`,
    [s.orderId]
  );
  shopifyReturn(lines, s.orderId);
  return s;
}

/** Admit directly through the ledger (stock is not consulted): the shape an op had when admitted. */
async function admittedDirectly(s: Awaited<ReturnType<typeof seeded>>, mutate?: (ops: any[]) => void) {
  const plan = planFor(s);
  mutate?.(plan.ops);
  const { insertAdmission } = await ledger();
  await insertAdmission(sys, { submissionId: s.id, seenSeq: 0, ops: plan.ops, reverseFulfillment: plan.reverseFulfillment });
  return plan.ops as any[];
}

const holds = (submissionId: string) =>
  q(`SELECT id, cause, exchange_operation_id, detail, taken_by, resolution FROM settlement_holds WHERE submission_id=$1 ORDER BY created_at`, [submissionId]);
const alerts = () => q(`SELECT dedupe_key, subject, body FROM ops_alerts ORDER BY dedupe_key`);
const ops = (submissionId: string) => q(`SELECT id, kind, state, attempt, owner, after FROM settlement_operations WHERE submission_id=$1`, [submissionId]);
const seqOf = async (submissionId: string) => Number((await q(`SELECT admission_seq FROM return_submissions WHERE id=$1`, [submissionId]))[0].admission_seq);
const sends = (name: string) => sent.filter((s) => s.name === name);

beforeAll(() => env.ready);
beforeEach(async () => {
  await env.reset();
  for (const k of Object.keys(answers)) delete answers[k];
  sent.length = 0;
  digest.length = 0;
  (await import("./support/amphoraStockMock")).resetStock(stock);
});

describe("admission reads Amphora before planning the replacement (§#4 (d))", () => {
  it("covered → admitted; the exchange obeys policy and gates every other op", async () => {
    const s = await seeded();
    expect(await admit(s.id, [2])).toMatchObject({ ok: true });
    expect(stock.reads).toBe(1);
    const rows = await ops(s.id);
    const exchange = rows.find((o) => o.kind === "exchange_order")!;
    expect(exchange.after).toBeNull();
    expect(rows.filter((o) => o.kind !== "exchange_order").every((o) => o.after === exchange.id)).toBe(true);
    expect(await holds(s.id)).toEqual([]);
  });

  it("short → one hold and one alert row, zero operations, the fence moved", async () => {
    const s = await seeded();
    stock.available[V] = 0;
    const out = await admit(s.id, [1]);
    expect(out).toMatchObject({ ok: false, held: expect.stringMatching(/^stock-short:/) });
    const [hold] = await holds(s.id);
    expect((out as any).held).toBe(`stock-short:${hold.id}`);
    expect(hold).toMatchObject({ cause: "stock-short", detail: { short: [{ sku: V, need: 1, available: 0, earlier: 0 }] } });
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`settlement-held:${hold.id}`);
    expect(rows[0].subject).toContain("#100");
    expect(rows[0].body).toContain(`--hold ${hold.id} --release`);
    expect(await ops(s.id)).toEqual([]);
    expect(await seqOf(s.id)).toBe(1);
  });

  it("unreadable → held for this run only: no hold, no alert, no operation", async () => {
    const s = await seeded();
    stock.reason = "amphora-http:503";
    expect(await admit(s.id, [1])).toEqual({ ok: false, held: "stock-unreadable:amphora-http:503" });
    expect(await holds(s.id)).toEqual([]);
    expect(await alerts()).toEqual([]);
    expect(await ops(s.id)).toEqual([]);
  });

  it("a blocking hold → held before anything is read", async () => {
    const s = await seeded();
    stock.available[V] = 0;
    await admit(s.id, [1]);
    const [hold] = await holds(s.id);
    stock.available[V] = 5;
    stock.reads = 0;
    expect(await admit(s.id, [1])).toEqual({ ok: false, held: `stock-held:${hold.id}` });
    expect(stock.reads).toBe(0);
    expect(await ops(s.id)).toEqual([]);
  });

  it("D2: an earlier-accepted promise counts against a later one; equal stamps count both ways", async () => {
    const first = await seeded({ orderId: "100", lines: [exchangeLine(1)] });
    const later = await seeded({ orderId: "200", lines: [exchangeLine(2)] });
    await q(`UPDATE return_submissions SET accepted_at = '2026-11-20T10:00:00Z' WHERE id=$1`, [first.id]);
    await q(`UPDATE return_submissions SET accepted_at = '2026-11-20T11:00:00Z' WHERE id=$1`, [later.id]);
    stock.available[V] = 1;
    // The later one sees the earlier one's open line; the earlier one does not see the later.
    expect(await admit(later.id, [2])).toMatchObject({ ok: false, held: expect.stringMatching(/^stock-short:/) });
    expect((await holds(later.id))[0].detail.short).toEqual([{ sku: V, need: 1, available: 1, earlier: 1 }]);
    shopifyReturn([exchangeLine(1)], "100");
    expect(await admit(first.id, [1])).toMatchObject({ ok: true });

    // Same stamp: each counts the other — neither may take the last unit.
    await env.reset();
    const a = await seeded({ orderId: "300", lines: [exchangeLine(3)] });
    const b = await seeded({ orderId: "400", lines: [exchangeLine(4)] });
    await q(`UPDATE return_submissions SET accepted_at = '2026-11-20T10:00:00Z'`);
    shopifyReturn([exchangeLine(3)], "300");
    expect(await admit(a.id, [3])).toMatchObject({ ok: false, held: expect.stringMatching(/^stock-short:/) });
    shopifyReturn([exchangeLine(4)], "400");
    expect(await admit(b.id, [4])).toMatchObject({ ok: false, held: expect.stringMatching(/^stock-short:/) });
  });
});

describe("a rejected exchange is held, never re-sent every run (§#4)", () => {
  it("userError → hold + alert + seq bump in one statement; claim refuses; --release makes it claimable", async () => {
    const s = await seeded();
    const planned = await admittedDirectly(s);
    const exchange = planned.find((o) => o.kind === "exchange_order");
    const sibling = planned.find((o) => o.kind !== "exchange_order");
    const seq = await seqOf(s.id);
    answers.SettlementOrderCreate = () => ({
      data: { orderCreate: { order: null, userErrors: [{ field: ["x"], message: "Insufficient inventory", code: "INVALID" }] } },
    });
    expect(await run(exchange.id)).toBe("rejected");
    const [hold] = await holds(s.id);
    expect(hold).toMatchObject({ cause: "exchange-rejected", exchange_operation_id: exchange.id });
    expect((await alerts()).map((a) => a.dedupe_key)).toEqual([`settlement-held:${hold.id}`]);
    expect(await seqOf(s.id)).toBe(seq + 1);

    const { claim, recoverableOperations } = await ledger();
    expect(await claim(sys, exchange.id, crypto.randomUUID())).toBeNull();
    expect(await claim(sys, sibling.id, crypto.randomUUID())).toBeNull();
    expect(await recoverableOperations(50)).toEqual([]);
    expect(await run(exchange.id)).toBe("not-claimed");
    expect(sends("SettlementOrderCreate")).toHaveLength(1);

    expect(await resolve(hold.id, "release", { evidence: "restocked" })).toMatchObject({ ok: true, written: true });
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: orderObject(exchange.request.check), userErrors: [] } } });
    expect(await run(exchange.id)).toBe("done");
    expect(sends("SettlementOrderCreate")).toHaveLength(2);
  });
});

describe("A1: Amphora authorizes every fresh orderCreate", () => {
  it("short at send time → not sent, back to pending with the attempt returned, one hold", async () => {
    const s = await seeded();
    const planned = await admittedDirectly(s);
    const exchange = planned.find((o) => o.kind === "exchange_order");
    stock.available[V] = 0; // Shopify would still say yes
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: orderObject(exchange.request.check), userErrors: [] } } });
    expect(await run(exchange.id)).toBe("held");
    expect(sends("SettlementOrderCreate")).toHaveLength(0);
    const row = (await ops(s.id)).find((o) => o.id === exchange.id)!;
    expect(row).toMatchObject({ state: "pending", attempt: 0, owner: null });
    const rows = await holds(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cause: "stock-short", detail: { operation: exchange.id } });
    expect(await alerts()).toHaveLength(1);
    expect(await run(exchange.id)).toBe("not-claimed");
  });

  it("a rejected exchange released while Amphora is still at 0 → no orderCreate, one new hold", async () => {
    const s = await seeded();
    const exchange = (await admittedDirectly(s)).find((o) => o.kind === "exchange_order");
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: null, userErrors: [{ field: ["x"], message: "no", code: "INVALID" }] } } });
    expect(await run(exchange.id)).toBe("rejected");
    const [first] = await holds(s.id);
    await resolve(first.id, "release", { evidence: "try again" });
    stock.available[V] = 0;
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: orderObject(exchange.request.check), userErrors: [] } } });
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    const report = await recoverSettlements(sys, { deadline: Date.now() + 60_000 });
    expect(report.ran).toEqual([{ op: exchange.id, kind: "exchange_order", from: "rejected", result: "held" }]);
    expect(sends("SettlementOrderCreate")).toHaveLength(1);
    const all = await holds(s.id);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ cause: "stock-short", resolution: null });
  });

  it("unreadable → wait: back to pending, attempt unchanged, nothing recorded; sent once readable", async () => {
    const s = await seeded();
    const exchange = (await admittedDirectly(s)).find((o) => o.kind === "exchange_order");
    stock.reason = "amphora-transport:ECONNRESET";
    expect(await run(exchange.id)).toBe("wait");
    expect((await ops(s.id)).find((o) => o.id === exchange.id)).toMatchObject({ state: "pending", attempt: 0, owner: null });
    expect(await holds(s.id)).toEqual([]);
    expect(await alerts()).toEqual([]);
    stock.reason = null;
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: orderObject(exchange.request.check), userErrors: [] } } });
    expect(await run(exchange.id)).toBe("done");
    expect((await ops(s.id)).find((o) => o.id === exchange.id)).toMatchObject({ state: "done", attempt: 1 });
  });
});

describe("A3: old shapes are refused and held", () => {
  it("an exchange frozen with DECREMENT_IGNORING_POLICY is never dispatched: one legacy-plan hold", async () => {
    const s = await seeded();
    const exchange = (
      await admittedDirectly(s, (planned) => {
        const x = planned.find((o) => o.kind === "exchange_order");
        x.request.variables.options.inventoryBehaviour = "DECREMENT_IGNORING_POLICY";
      })
    ).find((o) => o.kind === "exchange_order");
    answers.SettlementOrderCreate = () => ({ data: { orderCreate: { order: orderObject(exchange.request.check), userErrors: [] } } });
    expect(await run(exchange.id)).toBe("not-claimed");
    expect(await run(exchange.id)).toBe("not-claimed");
    expect(sends("SettlementOrderCreate")).toHaveLength(0);
    expect(stock.reads).toBe(0);
    const rows = await holds(s.id);
    expect(rows).toEqual([expect.objectContaining({ cause: "legacy-plan", detail: { operations: [exchange.id] } })]);
    expect(await alerts()).toHaveLength(1);
    expect((await alerts())[0].body).toContain(s.id);
    expect((await ops(s.id)).find((o) => o.id === exchange.id)!.state).toBe("pending");
  });

  it("a sibling not gated on the exchange is never claimed: one legacy-plan hold naming every such op", async () => {
    const s = await seeded();
    const planned = await admittedDirectly(s, (p) => {
      for (const o of p) if (o.kind !== "exchange_order") o.after = null;
    });
    const sibling = planned.find((o) => o.kind !== "exchange_order");
    expect(await run(sibling.id)).toBe("not-claimed");
    expect(sent).toEqual([]);
    const [hold] = await holds(s.id);
    expect(hold.cause).toBe("legacy-plan");
    const ungated = planned.filter((o) => o.kind !== "exchange_order").map((o) => o.id);
    expect(ungated).toContain(sibling.id);
    expect([...hold.detail.operations].sort()).toEqual([...ungated].sort());
  });
});

describe("A2: take first, then act", () => {
  async function heldShort() {
    const s = await seeded();
    stock.available[V] = 0;
    await admit(s.id, [1]);
    const [hold] = await holds(s.id);
    return { s, hold };
  }

  it("--take: holder manual, not-done ops void; --done: rows refunded, the submission is never admitted again", async () => {
    const s = await seeded();
    const planned = await admittedDirectly(s);
    const exchange = planned.find((o) => o.kind === "exchange_order");
    stock.available[V] = 0;
    expect(await run(exchange.id)).toBe("held");
    const [hold] = await holds(s.id);

    expect(await resolve(hold.id, "done")).toMatchObject({ ok: false, reason: expect.stringMatching(/never taken/) });
    expect(await resolve(hold.id, "take", { by: "santi" })).toMatchObject({ ok: true, written: true });
    expect((await q(`SELECT holder FROM return_submissions WHERE id=$1`, [s.id]))[0].holder).toBe("manual");
    expect((await ops(s.id)).every((o) => o.state === "void")).toBe(true);
    expect(await resolve(hold.id, "release")).toMatchObject({ ok: false, reason: expect.stringMatching(/--done/) });

    expect(await resolve(hold.id, "done", { by: "", evidence: "orderCreate by hand #40000, refund in Stripe" })).toMatchObject({ ok: true });
    const [closed] = await holds(s.id);
    expect(closed).toMatchObject({ resolution: "manual", taken_by: "santi" });
    expect((await q(`SELECT resolved_by FROM settlement_holds WHERE id=$1`, [hold.id]))[0].resolved_by).toBe("santi");
    expect((await q(`SELECT refunded FROM productsorder ORDER BY id`)).map((r) => r.refunded)).toEqual([true, true]);
    expect(await admit(s.id, [1, 2])).toEqual({ ok: false, held: `resolved-by-hand:${hold.id}` });
    expect((await q(`SELECT holder FROM return_submissions WHERE id=$1`, [s.id]))[0].holder).toBe("manual");
  });

  it("--take is refused while an operation is in flight", async () => {
    const { s, hold } = await heldShort();
    await q(`UPDATE return_submissions SET holder='settlement' WHERE id=$1`, [s.id]);
    await q(
      `INSERT INTO settlement_operations (id, submission_id, kind, scope_key, request, state, attempt, dispatched_at)
       VALUES (gen_random_uuid(), $1, 'process_refund', 'money:x', '{}'::jsonb, 'dispatched', 1, now())`,
      [s.id]
    );
    expect(await resolve(hold.id, "take")).toMatchObject({ ok: false, reason: expect.stringMatching(/in flight/) });
  });

  it("a taken submission cannot be cancelled by the customer", async () => {
    const { s, hold } = await heldShort();
    await resolve(hold.id, "take");
    const { claimForCancellation } = await import("@/lib/server/submissionScope");
    expect(await claimForCancellation(vsub(s.orderId, s.id))).toBe("settled");
    expect((await q(`SELECT holder FROM return_submissions WHERE id=$1`, [s.id]))[0].holder).toBe("manual");
  });

  it("a hold taken over 24 h ago and not done is in the recovery digest, once a day", async () => {
    const { hold } = await heldShort();
    await resolve(hold.id, "take", { by: "santi" });
    await q(`UPDATE settlement_holds SET taken_at = now() - interval '25 hours'`);
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    const report = await recoverSettlements(sys, { deadline: Date.now() + 60_000 });
    expect(report.takenHoldsNotDone).toBe(1);
    const day = new Date().toISOString().slice(0, 10);
    expect(digest.map((d) => d.dedupeKey)).toContain(`hold-taken-not-done:${hold.id}:${day}`);
  });

  it("dry run writes nothing", async () => {
    const { s, hold } = await heldShort();
    const { resolveHold } = await import("@/lib/settlement/holdResolution");
    const out = await resolveHold(sys, hold.id, { verb: "take", by: "santi", evidence: "" }, { write: false });
    expect(out).toMatchObject({ ok: true, written: false });
    expect((await q(`SELECT holder FROM return_submissions WHERE id=$1`, [s.id]))[0].holder).toBeNull();
  });
});
